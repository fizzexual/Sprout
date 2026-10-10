/* Distribution primitives: portable SHA-256, bounded files, safe relative paths. */
#ifndef SPROUT_DISTRIBUTION_COMMON_H
#define SPROUT_DISTRIBUTION_COMMON_H
#include <stdint.h>
#include <errno.h>

static uint32_t dist_rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
static void dist_sha_block(uint32_t h[8], const unsigned char b[64]) {
  static const uint32_t k[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  };
  uint32_t w[64];
  for (int i=0;i<16;i++) w[i]=((uint32_t)b[i*4]<<24)|((uint32_t)b[i*4+1]<<16)|((uint32_t)b[i*4+2]<<8)|b[i*4+3];
  for (int i=16;i<64;i++) { uint32_t a=w[i-15],z=w[i-2];
    w[i]=w[i-16]+(dist_rotr(a,7)^dist_rotr(a,18)^(a>>3))+w[i-7]+(dist_rotr(z,17)^dist_rotr(z,19)^(z>>10)); }
  uint32_t a=h[0],b0=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],z=h[7];
  for (int i=0;i<64;i++) {
    uint32_t t=z+(dist_rotr(e,6)^dist_rotr(e,11)^dist_rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i];
    uint32_t u=(dist_rotr(a,2)^dist_rotr(a,13)^dist_rotr(a,22))+((a&b0)^(a&c)^(b0&c));
    z=g;g=f;f=e;e=d+t;d=c;c=b0;b0=a;a=t+u;
  }
  h[0]+=a;h[1]+=b0;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=z;
}
static void dist_sha256(const unsigned char *data, size_t len, unsigned char out[32]) {
  uint32_t h[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  size_t full=len/64; for (size_t i=0;i<full;i++) dist_sha_block(h,data+i*64);
  unsigned char tail[128]={0}; size_t n=len%64; if (n) memcpy(tail,data+full*64,n); tail[n]=0x80;
  size_t end=n<56?64:128; uint64_t bits=(uint64_t)len*8;
  for (int i=0;i<8;i++) tail[end-1-i]=(unsigned char)(bits>>(8*i));
  dist_sha_block(h,tail); if(end==128)dist_sha_block(h,tail+64);
  for (int i=0;i<8;i++) for(int j=0;j<4;j++)out[i*4+j]=(unsigned char)(h[i]>>(24-8*j));
}
static void dist_shahex(const unsigned char *data, size_t len, char out[65]) {
  static const char hex[]="0123456789abcdef"; unsigned char digest[32]; dist_sha256(data,len,digest);
  for(int i=0;i<32;i++){out[i*2]=hex[digest[i]>>4];out[i*2+1]=hex[digest[i]&15];}out[64]=0;
}
static int dist_hex_digest(const char *s) {
  if(strlen(s)!=64)return 0;
  for(int i=0;i<64;i++)if(!isxdigit((unsigned char)s[i]))return 0;
  return 1;
}
/* Portable paths only: no drive names, traversal, ambiguous separators or Windows devices. */
static int dist_safe_path(const char *s) {
  if(!s[0]||strlen(s)>=800||s[0]=='/'||s[0]=='\\')return 0;
  const char *start=s;
  for(const char *p=s;;p++) {
    if(*p=='\\'||*p==':'||((unsigned char)*p<32&&*p))return 0;
    if(*p=='/'||!*p) {
      size_t n=(size_t)(p-start);if(!n||(n==1&&start[0]=='.')||(n==2&&start[0]=='.'&&start[1]=='.')||start[n-1]=='.'||start[n-1]==' ')return 0;
      char part[16];size_t k=0;while(k<n&&start[k]!='.'&&k<sizeof(part)-1){part[k]=(char)toupper((unsigned char)start[k]);k++;}part[k]=0;
      if(!strcmp(part,"CON")||!strcmp(part,"PRN")||!strcmp(part,"AUX")||!strcmp(part,"NUL")||
         (strlen(part)==4&&(!strncmp(part,"COM",3)||!strncmp(part,"LPT",3))&&part[3]>='1'&&part[3]<='9'))return 0;
      if(!*p)break;
      start=p+1;
    }
  }
  return 1;
}
static int dist_write(const char *path,const unsigned char *data,size_t len) {
  ensure_parent_dirs(path); FILE *f=fopen(path,"wb");if(!f)return 0;
  int ok=fwrite(data,1,len,f)==len; if(fclose(f)!=0)ok=0;return ok;
}
static unsigned char *read_bytes(const char *path, long *len) {
  FILE *f=fopen(path,"rb");if(!f)return NULL;
  if(fseek(f,0,SEEK_END)!=0){fclose(f);return NULL;}long n=ftell(f);
  if(n<0||n>(128L<<20)||fseek(f,0,SEEK_SET)!=0){fclose(f);return NULL;}
  unsigned char *b=(unsigned char *)malloc((size_t)n+1);if(!b){fclose(f);return NULL;}
  size_t got=fread(b,1,(size_t)n,f);int bad=ferror(f);fclose(f);
  if(bad||got!=(size_t)n){free(b);return NULL;}b[n]=0;*len=n;return b;
}
static int dist_dir(const char *path) {
#ifdef _WIN32
  DWORD a=GetFileAttributesA(path);return a!=INVALID_FILE_ATTRIBUTES&&(a&FILE_ATTRIBUTE_DIRECTORY)!=0;
#else
  struct stat st;return stat(path,&st)==0&&S_ISDIR(st.st_mode);
#endif
}
/* A package may not write through symlinks/junctions left in its destination tree. */
static int dist_no_links(const char *path) {
  char copy[1024];if(strlen(path)>=sizeof copy)return 0;strcpy(copy,path);
  for(char *p=copy;;p++)if(*p=='/'||*p=='\\'||!*p){char saved=*p;*p=0;
#ifdef _WIN32
    DWORD attrs=GetFileAttributesA(copy);int link=attrs!=INVALID_FILE_ATTRIBUTES&&(attrs&FILE_ATTRIBUTE_REPARSE_POINT);
#else
    struct stat st;int link=lstat(copy,&st)==0&&S_ISLNK(st.st_mode);
#endif
    *p=saved;if(link)return 0;if(!saved)break;
  }
  return 1;
}
static int dist_atomic_write(const char *path,const unsigned char *data,size_t len) {
  if(!dist_no_links(path))return 0;
  ensure_parent_dirs(path);
  if(!dist_no_links(path))return 0;
  char temp[1100];int ok=0;
#ifdef _WIN32
  HANDLE f=INVALID_HANDLE_VALUE;
  for(int i=0;i<100;i++) {
    if(snprintf(temp,sizeof temp,"%s.tmp-%lu-%d",path,(unsigned long)GetCurrentProcessId(),i)>=(int)sizeof temp)return 0;
    f=CreateFileA(temp,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(f!=INVALID_HANDLE_VALUE)break;
  }
  if(f==INVALID_HANDLE_VALUE)return 0;
  DWORD wrote=0;ok=len<=0xffffffffu&&WriteFile(f,data,(DWORD)len,&wrote,NULL)&&wrote==(DWORD)len;
  if(!FlushFileBuffers(f))ok=0;
  CloseHandle(f);
  if(ok)ok=MoveFileExA(temp,path,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0;
  if(!ok)DeleteFileA(temp);
#else
  if(snprintf(temp,sizeof temp,"%s.tmp-XXXXXX",path)>=(int)sizeof temp)return 0;
  int fd=mkstemp(temp);if(fd<0)return 0;FILE *f=fdopen(fd,"wb");if(!f){close(fd);remove(temp);return 0;}
  ok=fwrite(data,1,len,f)==len&&fflush(f)==0&&fsync(fd)==0;if(fclose(f)!=0)ok=0;
  if(ok)ok=rename(temp,path)==0;
  if(!ok)remove(temp);
#endif
  return ok;
}
static void dist_u64(unsigned char b[8],uint64_t n){for(int i=0;i<8;i++)b[i]=(unsigned char)(n>>(8*i));}
static uint64_t dist_read_u64(const unsigned char *b){uint64_t n=0;for(int i=0;i<8;i++)n|=(uint64_t)b[i]<<(8*i);return n;}
#endif
