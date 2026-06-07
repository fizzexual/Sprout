// voice.ts — a from-scratch Discord voice connection: join a voice channel and
// stream Opus audio over UDP with zero npm dependencies (Node's built-in
// WebSocket, UDP (node:dgram) and crypto).
//
// NOTE: This is no longer used for live playback. As of 2026-03-01 Discord
// REQUIRES the DAVE end-to-end-encryption protocol (MLS + AES-128-GCM) to join
// voice; a channel without it closes with code 4017. DAVE can't be done
// dependency-free, so the music extension now uses @discordjs/voice (which uses
// @snazzah/davey). This file is kept as a reference implementation of the voice
// transport — its cipher and Ogg/Opus demuxer are pure functions the test-suite
// still checks, and it was correct for the pre-DAVE protocol.
//
// Discord's voice protocol here: a second WebSocket, a UDP socket, IP discovery,
// RTP packetisation, and AEAD encryption.

import { createCipheriv } from "node:crypto";
import { createSocket } from "node:dgram";
import type { Socket as UdpSocket } from "node:dgram";

// --- Encryption ---------------------------------------------------------------
//
// Discord's modern voice modes are "rtpsize" AEAD: the 12-byte RTP header is the
// associated data, the audio is encrypted, and a 4-byte incrementing nonce is
// appended to the packet. We support the two that Node's crypto can do natively:
//   - aead_aes256_gcm_rtpsize   (preferred; AES-256-GCM is built in)
//   - aead_xchacha20_poly1305_rtpsize  (fallback; XChaCha20 = HChaCha20 + ChaCha20)

export const SUPPORTED_MODES = ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"];

// Pick the best encryption mode we can do from the ones the server offers.
export function chooseMode(serverModes: string[]): string | null {
  for (const m of SUPPORTED_MODES) if (serverModes.includes(m)) return m;
  return null;
}

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// HChaCha20: derive a 32-byte subkey from a key + 16-byte nonce (the heart of
// XChaCha20). It's the ChaCha20 core with no feed-forward, keeping words 0-3,12-15.
export function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a: number, b: number, c: number, d: number): void => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
  };
  for (let r = 0; r < 10; r++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  const words = [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]];
  for (let i = 0; i < 8; i++) out.writeUInt32LE(words[i], i * 4);
  return out;
}

// Encrypt one audio packet. Returns ciphertext + auth tag + 4-byte nonce, which
// is appended after the RTP header to form the wire packet.
export function sealAudio(mode: string, key: Buffer, header: Buffer, audio: Buffer, nonceCounter: number): Buffer {
  const nonce4 = Buffer.alloc(4);
  nonce4.writeUInt32BE(nonceCounter >>> 0, 0);

  if (mode === "aead_aes256_gcm_rtpsize") {
    const iv = Buffer.alloc(12);
    nonce4.copy(iv, 0); // 4-byte counter, zero-padded to 12
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    const enc = Buffer.concat([cipher.update(audio), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag(), nonce4]);
  }

  if (mode === "aead_xchacha20_poly1305_rtpsize") {
    // XChaCha20: 24-byte nonce = counter (4 bytes) + zeros. Subkey from the
    // first 16 nonce bytes; the ChaCha20-Poly1305 nonce is the last 8 (zero-padded).
    const xnonce = Buffer.alloc(24);
    nonce4.copy(xnonce, 0);
    const subkey = hchacha20(key, xnonce.subarray(0, 16));
    const chachaNonce = Buffer.alloc(12);
    xnonce.subarray(16, 24).copy(chachaNonce, 4);
    const cipher = createCipheriv("chacha20-poly1305", subkey, chachaNonce, { authTagLength: 16 });
    cipher.setAAD(header);
    const enc = Buffer.concat([cipher.update(audio), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag(), nonce4]);
  }

  throw new Error(`unsupported voice mode: ${mode}`);
}

// --- Ogg/Opus demuxer ---------------------------------------------------------
//
// ffmpeg gives us Opus audio wrapped in an Ogg container (a stream of "pages").
// Discord wants the raw Opus packets, one per 20ms frame. This pulls them out,
// handling Ogg's segment "lacing" and packets that span page boundaries. The
// first two packets (OpusHead, OpusTags) are headers and are skipped.

export class OggOpusDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  private headerPacketsSeen = 0;
  private partial: Buffer[] = [];

  // Feed bytes in; get back any complete Opus audio packets discovered so far.
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const packets: Buffer[] = [];

    while (true) {
      if (this.buf.length < 27) break; // not enough for a page header
      if (this.buf.toString("ascii", 0, 4) !== "OggS") {
        // resync: drop a byte until we find a capture pattern
        const next = this.buf.indexOf("OggS", 1, "ascii");
        if (next === -1) { this.buf = this.buf.subarray(this.buf.length - 3); break; }
        this.buf = this.buf.subarray(next);
        continue;
      }
      const segCount = this.buf[26];
      const headerLen = 27 + segCount;
      if (this.buf.length < headerLen) break;
      const segTable = this.buf.subarray(27, headerLen);
      let bodyLen = 0;
      for (let i = 0; i < segCount; i++) bodyLen += segTable[i];
      if (this.buf.length < headerLen + bodyLen) break; // page body not all here yet

      let offset = headerLen;
      let segLen = 0;
      for (let i = 0; i < segCount; i++) {
        const lace = segTable[i];
        segLen += lace;
        if (lace < 255) {
          // end of a packet (lace 255 means "continues in next segment")
          const piece = this.buf.subarray(offset, offset + segLen);
          this.partial.push(Buffer.from(piece));
          const packet = this.partial.length === 1 ? this.partial[0] : Buffer.concat(this.partial);
          this.partial = [];
          offset += segLen;
          segLen = 0;
          if (this.headerPacketsSeen < 2) this.headerPacketsSeen++;
          else packets.push(packet);
        }
      }
      if (segLen > 0) {
        // a packet continues onto the next page
        this.partial.push(Buffer.from(this.buf.subarray(offset, offset + segLen)));
      }
      this.buf = this.buf.subarray(headerLen + bodyLen);
    }
    return packets;
  }
}

// --- The live voice connection ------------------------------------------------

export interface VoicePlayer {
  // Play an Ogg/Opus stream (ffmpeg's stdout). Resolves/▶ via onFinish.
  playOgg(stream: NodeJS.ReadableStream): void;
  stop(): void;            // stop the current track (keep the connection)
  destroy(): void;         // leave the channel, tear everything down
  updateServer(endpoint: string, token: string): void;  // a refreshed VOICE_SERVER_UPDATE
  onFinish(cb: () => void): void;
  isPlaying(): boolean;
}

interface VoiceParams {
  endpoint: string;       // from VOICE_SERVER_UPDATE
  token: string;          // from VOICE_SERVER_UPDATE
  guildId: string;
  userId: string;
  sessionId: string;      // from VOICE_STATE_UPDATE
  onError?: (msg: string) => void;
  onReady?: () => void;
}

const FRAME_SIZE = 960;   // 48kHz * 20ms
const FRAME_MS = 20;
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

// Connect the voice WebSocket + UDP and return a player. The audio send loop is
// a self-correcting 20ms timer that reads frames the demuxer produces.
// Milestone trace — always on, but it only prints while a song is connecting/
// playing, so it's silent the rest of the time. Tells you exactly how far the
// voice handshake got if something's wrong.
function vlog(msg: string): void { console.log(`🎙️  [voice] ${msg}`); }
// Extra per-frame counters, only with SPROUT_VOICE_DEBUG=1.
const VOICE_DEBUG = process.env.SPROUT_VOICE_DEBUG === "1" || process.env.SPROUT_VOICE_DEBUG === "true";
function vverbose(msg: string): void { if (VOICE_DEBUG) console.log(`🎙️  [voice] ${msg}`); }

export function connectVoice(params: VoiceParams): VoicePlayer {
  // Voice gateway v8. IMPORTANT: connect to the endpoint Discord gives us WITH the
  // port it specifies — voice servers are no longer all on :443, and connecting to
  // the wrong port reaches a server that doesn't know our session, which closes
  // with 4006 ("session no longer valid"). v8 tags each message with `seq`;
  // heartbeats echo the latest as `seq_ack`. (We still retry transient closes.)
  let endpoint = params.endpoint;
  let token = params.token;
  const wsUrl = (): string => `wss://${endpoint}/?v=8`;
  const udp: UdpSocket = createSocket("udp4");
  let ws: WebSocket | null = null;
  let destroyed = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 6;
  const FATAL = new Set([1000, 4004, 4011, 4012, 4014, 4016, 4017]); // closes we don't retry

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let mode = "";
  let secretKey: Buffer | null = null;
  let ssrc = 0;
  let remote = { ip: "", port: 0 };
  let sequence = 0;
  let timestamp = 0;
  let nonce = 0;
  let speaking = false;

  const demuxer = new OggOpusDemuxer();
  let frames: Buffer[] = [];
  let streaming = false;
  let sendTimer: ReturnType<typeof setInterval> | null = null;
  let nextTime = 0;
  const finishCbs: Array<() => void> = [];

  const fail = (m: string): void => params.onError?.(m);

  const sendVoice = (op: number, d: unknown): void => {
    try { ws?.send(JSON.stringify({ op, d })); } catch { /* socket closing */ }
  };

  const setSpeaking = (on: boolean): void => {
    if (speaking === on) return;
    speaking = on;
    sendVoice(5, { speaking: on ? 1 : 0, delay: 0, ssrc });
  };

  let framesSent = 0;
  const sendFrame = (opus: Buffer): void => {
    if (!secretKey) return;
    const header = Buffer.alloc(12);
    header[0] = 0x80; header[1] = 0x78;
    header.writeUInt16BE(sequence, 2);
    header.writeUInt32BE(timestamp, 4);
    header.writeUInt32BE(ssrc, 8);
    const body = sealAudio(mode, secretKey, header, opus, nonce);
    nonce = (nonce + 1) >>> 0;
    sequence = (sequence + 1) & 0xffff;
    timestamp = (timestamp + FRAME_SIZE) >>> 0;
    udp.send(Buffer.concat([header, body]), remote.port, remote.ip, (e) => { if (e) fail("voice UDP send failed"); });
    framesSent++;
    if (framesSent === 1) vlog("sending first audio frame 🔊  (you should hear sound now)");
    else if (framesSent % 250 === 0) vverbose(`sent ${framesSent} frames (~${Math.round(framesSent / 50)}s)`);
  };

  const tick = (): void => {
    if (!streaming) return;
    if (frames.length === 0) return; // wait for more demuxed audio
    setSpeaking(true);
    nextTime += FRAME_MS;
    const frame = frames.shift()!;
    sendFrame(frame);
  };

  const startSendLoop = (): void => {
    if (sendTimer) return;
    nextTime = Date.now();
    sendTimer = setInterval(tick, FRAME_MS);
  };

  const finishTrack = (): void => {
    streaming = false;
    // play a few silence frames so Discord doesn't cut off the tail
    for (let i = 0; i < 5; i++) sendFrame(SILENCE);
    setSpeaking(false);
    const cbs = finishCbs.slice();
    cbs.forEach((cb) => cb());
  };

  // v8 tags each server message with a sequence number; heartbeats echo the latest.
  let lastSeq = -1;

  // --- voice websocket lifecycle (re-runnable, so we can retry close 4006) ---
  const connectWs = (): void => {
    // reset per-connection state for a fresh handshake
    secretKey = null; ssrc = 0; sequence = 0; timestamp = 0; nonce = 0; speaking = false; mode = ""; lastSeq = -1;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    vlog(`connecting to ${wsUrl()}${attempts ? `  (retry ${attempts}/${MAX_ATTEMPTS})` : ""}`);
    ws = new WebSocket(wsUrl());

    ws.addEventListener("open", () => {
      const sid = params.sessionId ? `${params.sessionId.slice(0, 4)}…(${params.sessionId.length})` : "MISSING";
      vlog(`websocket open — identifying (user=${params.userId || "MISSING"}, session=${sid}, token=${token ? `present(${token.length})` : "MISSING"})`);
      sendVoice(0, { server_id: params.guildId, user_id: params.userId, session_id: params.sessionId, token });
    });

  ws.addEventListener("message", (ev: { data: unknown }) => {
    let msg: { op: number; d: Record<string, unknown>; seq?: number };
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (typeof msg.seq === "number") lastSeq = msg.seq;

    if (msg.op === 8) {
      const interval = Number((msg.d as { heartbeat_interval?: number }).heartbeat_interval) || 13750;
      vlog(`hello — heartbeat every ${interval}ms`);
      heartbeat = setInterval(() => sendVoice(3, { t: Date.now(), seq_ack: Math.max(lastSeq, 0) }), interval);
    } else if (msg.op === 2) {
      // READY: pick a mode, open UDP, do IP discovery
      const d = msg.d as { ssrc: number; ip: string; port: number; modes: string[] };
      ssrc = d.ssrc; remote = { ip: d.ip, port: d.port };
      vlog(`ready — ssrc=${ssrc}, server=${d.ip}:${d.port}`);
      vlog(`server encryption modes: ${(d.modes || []).join(", ")}`);
      const chosen = chooseMode(d.modes);
      if (!chosen) { fail(`This voice server only offers modes Sprout can't do yet (${(d.modes || []).join(", ")}).`); return; }
      mode = chosen;
      vlog(`using encryption mode: ${mode}`);
      ipDiscovery(udp, ssrc, remote, (localIp, localPort) => {
        vlog(`ip discovery -> we are ${localIp}:${localPort}; selecting protocol`);
        sendVoice(1, { protocol: "udp", data: { address: localIp, port: localPort, mode } });
      }, fail);
    } else if (msg.op === 4) {
      // SESSION DESCRIPTION: we have the secret key, ready to send audio
      const d = msg.d as { secret_key: number[] };
      secretKey = Buffer.from(d.secret_key);
      attempts = 0; // handshake succeeded — reset the retry budget
      vlog(`session description — secret key (${secretKey.length} bytes). Audio loop starting.`);
      startSendLoop();
      params.onReady?.();
    }
  });

    ws.addEventListener("error", () => vverbose("websocket error event"));
    ws.addEventListener("close", (ev: { code: number; reason?: string }) => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      vlog(`websocket closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
      if (destroyed) return;
      if (FATAL.has(ev.code)) {
        if (ev.code === 4004) fail("Discord rejected the voice token (4004).");
        else if (ev.code === 4016) fail("This voice server needs an encryption mode Sprout can't do (4016).");
        else if (ev.code === 4017) fail("Discord now requires end-to-end voice encryption (the DAVE protocol) to join voice. Sprout's zero-dependency bot can't do that yet (close 4017).");
        return;
      }
      // Recoverable (4006 session race, 4009 timeout, 4015 server crash, …): retry.
      attempts++;
      if (attempts > MAX_ATTEMPTS) { fail(`Couldn't connect to voice after ${MAX_ATTEMPTS} tries (last close ${ev.code}).`); return; }
      const wait = Math.min(400 * attempts, 2500);
      vlog(`reconnecting in ${wait}ms (close ${ev.code}, attempt ${attempts}/${MAX_ATTEMPTS})`);
      setTimeout(() => { if (!destroyed) connectWs(); }, wait);
    });
  };

  connectWs();

  return {
    playOgg(stream) {
      frames = [];
      streaming = true;
      let demuxed = 0;
      let gotData = false;
      vlog("playOgg: waiting for audio from ffmpeg…");
      stream.on("data", (chunk: Buffer) => {
        if (!gotData) { gotData = true; vlog("playOgg: receiving audio bytes from ffmpeg"); }
        const packets = demuxer.push(chunk);
        demuxed += packets.length;
        for (const pkt of packets) frames.push(pkt);
      });
      // Warn loudly if ffmpeg produced no Opus frames (usually a missing tool or
      // a format ffmpeg couldn't read) — this is the #1 "joins but silent" cause.
      const watchdog = setTimeout(() => {
        if (demuxed === 0) {
          console.error("🌱 No audio came through. Check that ffmpeg+yt-dlp are installed and that");
          console.error("   ffmpeg supports libopus. Run with SPROUT_VOICE_DEBUG=1 for details.");
        }
      }, 6000);
      stream.on("end", () => {
        clearTimeout(watchdog);
        vlog(`playOgg: ffmpeg stream ended (${demuxed} opus frames total)`);
        const drain = setInterval(() => {
          if (frames.length === 0) { clearInterval(drain); finishTrack(); }
        }, FRAME_MS);
      });
      stream.on("error", () => { clearTimeout(watchdog); fail("The audio stream had a problem."); });
    },
    stop() {
      frames = [];
      streaming = false;
      setSpeaking(false);
    },
    updateServer(newEndpoint: string, newToken: string) {
      if (newEndpoint) endpoint = newEndpoint;
      if (newToken) token = newToken;
      vverbose("voice server info updated");
    },
    destroy() {
      destroyed = true;
      streaming = false;
      if (sendTimer) clearInterval(sendTimer);
      if (heartbeat) clearInterval(heartbeat);
      try { ws?.close(); } catch { /* already closed */ }
      try { udp.close(); } catch { /* already closed */ }
    },
    onFinish(cb) { finishCbs.push(cb); },
    isPlaying() { return streaming; },
  };
}

// Discord IP discovery: send a 74-byte packet, read back our public ip/port.
function ipDiscovery(
  udp: UdpSocket,
  ssrc: number,
  remote: { ip: string; port: number },
  done: (ip: string, port: number) => void,
  fail: (m: string) => void,
): void {
  const packet = Buffer.alloc(74);
  packet.writeUInt16BE(0x1, 0);      // type: request
  packet.writeUInt16BE(70, 2);       // length
  packet.writeUInt32BE(ssrc, 4);
  udp.once("message", (msg: Buffer) => {
    // bytes 8..71 = null-terminated address string; last 2 bytes = port
    const end = msg.indexOf(0, 8);
    const ip = msg.toString("ascii", 8, end === -1 ? 72 : end);
    const port = msg.readUInt16BE(msg.length - 2);
    done(ip, port);
  });
  udp.send(packet, remote.port, remote.ip, (e) => { if (e) fail("Couldn't reach the voice server."); });
}
