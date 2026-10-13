/* Candidate-only helper/allocation controls:16 finite cases, no protected pages.
   Compile only after a distinct root seal. Never include/run the original C. */
#define main sprout_candidate_cli_main
#include "../sprout.c"
#undef main

typedef struct { const char *id; unsigned char data[5]; size_t length; int step; } StepCase;

int main(void) {
  const StepCase cases[] = {
    {"empty", {0}, 0, 0},
    {"ascii", {0x41}, 1, 1},
    {"valid2", {0xc2,0xa2}, 2, 2},
    {"valid3", {0xe2,0x82,0xac}, 3, 3},
    {"valid4", {0xf0,0x9f,0x8c,0xb1}, 4, 4},
    {"partial2_1", {0xc2}, 1, 1},
    {"partial3_1", {0xe2}, 1, 1},
    {"partial3_2", {0xe2,0x82}, 2, 2},
    {"partial4_1", {0xf0}, 1, 1},
    {"partial4_2", {0xf0,0x9f}, 2, 2},
    {"partial4_3", {0xf0,0x9f,0x8c}, 3, 3},
    {"nonlead80", {0x80}, 1, 1},
    {"nonleadff", {0xff}, 1, 1},
    {"legacy2", {0xc2,0x41}, 2, 2},
    {"legacy3", {0xe2,0x41,0x42}, 3, 3},
    {"legacy4", {0xf0,0x41,0x42,0x43}, 4, 4}
  };
  size_t total_groups = 0;
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    const StepCase *test = &cases[i];
    char *text = malloc(test->length + 1);
    if (!text) { fputs("candidate fixture allocation failed\n", stderr); return 2; }
    memcpy(text, test->data, test->length); text[test->length] = 0;
    if (utf8_step_terminated(text) != test->step) {
      fprintf(stderr, "candidate step differs: %s\n", test->id); free(text); return 1;
    }
    size_t offset = 0, groups = 0;
    while (text[offset]) {
      int step = utf8_step_terminated(text + offset);
      if (step < 1 || (size_t)step > test->length - offset) {
        fprintf(stderr, "candidate advance differs: %s\n", test->id); free(text); return 1;
      }
      offset += (size_t)step; groups++;
    }
    if (offset != test->length || groups != (test->length ? 1u : 0u)) {
      fprintf(stderr, "candidate endpoint differs: %s\n", test->id); free(text); return 1;
    }
    total_groups += groups; free(text);
  }
  if (total_groups != 15) { fputs("candidate total differs\n", stderr); return 1; }
  puts("{\"ok\":true,\"cases\":16,\"groups\":15}");
  return 0;
}
