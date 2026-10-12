/* Required tagged preparation-array oracle. No runtime introspection API. */
#ifndef REVIEW_CANDIDATE
#define REVIEW_CANDIDATE 1
#elif REVIEW_CANDIDATE != 1
#error This fixture requires the preparation ownership candidate.
#endif
/* Private tagged array ownership oracle, not a general heap/leak detector. */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
static int review_refuse_malloc;
#if REVIEW_CANDIDATE
static int review_allocation_tag, review_refuse_reserve;
static size_t review_registry_calls, review_highwater;
#endif
static void *review_buffer_alloc(size_t bytes,int tag);
static void review_buffer_free(void *pointer);
#if REVIEW_CANDIDATE
static void *review_registry_reserve(void *pointer,size_t bytes);
static void *review_owned_alloc(size_t count,size_t item,int line,const char *message,int tag);
#endif
#define main reviewed_sprout_main
#if REVIEW_CANDIDATE
#include "instrumented/src/sprout.c"
#else
#include "original-instrumented/src/sprout.c"
#endif
#undef main
typedef struct {size_t attempted,allocated,freed,live,bytes,refused;} ReviewCount;
static ReviewCount review_counts[3];
static void *review_pointers[512];
static size_t review_sizes[512];
static int review_tags[512];
static void *review_buffer_alloc(size_t bytes,int tag) {
  if(tag<0||tag>2){fputs("counter tag invalid\n",stderr);exit(94);}
  ReviewCount *c=&review_counts[tag]; c->attempted++;
  if(review_refuse_malloc>0&&--review_refuse_malloc==0){c->refused++;return NULL;}
  void *pointer=malloc(bytes); if(!pointer)return NULL;
  for(size_t i=0;i<512;i++)if(!review_pointers[i]){
    review_pointers[i]=pointer;review_sizes[i]=bytes;review_tags[i]=tag;
    c->allocated++;c->live++;c->bytes+=bytes;return pointer;
  }
  fputs("bounded counter capacity exceeded\n",stderr);exit(94);
}
static void review_buffer_free(void *pointer) {
  if(!pointer)return;
  for(size_t i=0;i<512;i++)if(review_pointers[i]==pointer){
    ReviewCount *c=&review_counts[review_tags[i]];c->freed++;c->live--;c->bytes-=review_sizes[i];
    review_pointers[i]=NULL;review_sizes[i]=0;free(pointer);return;
  }
  fputs("counter unowned or duplicate release\n",stderr);exit(94);
}
#if REVIEW_CANDIDATE
static void *review_registry_reserve(void *pointer,size_t bytes) {
  review_registry_calls++;
  if(review_refuse_reserve){review_refuse_reserve=0;return NULL;}
  return realloc(pointer,bytes);
}
static void *review_owned_alloc(size_t count,size_t item,int line,const char *message,int tag) {
  review_allocation_tag=tag;
  void *pointer=temporary_buffer_alloc(count,item,line,message);
  if(temporary_buffer_count>review_highwater)review_highwater=temporary_buffer_count;
  return pointer;
}
static int review_tombstones(void) {
  void *first=review_owned_alloc(1,sizeof(int),0,"first",0);
  void *second=review_owned_alloc(1,sizeof(int),0,"second",0);
  void *third=review_owned_alloc(1,sizeof(int),0,"third",0);(void)third;
  temporary_buffer_release(second);
  if(temporary_buffer_count!=3||temporary_buffers[1]!=NULL||review_counts[0].live!=2)return 95;
  temporary_buffer_restore(1);
  if(temporary_buffer_count!=1||temporary_buffers[0]!=first||review_counts[0].live!=1||temporary_buffers[1]||temporary_buffers[2])return 95;
  temporary_buffer_restore(0);return review_counts[0].live?95:0;
}
#endif
static void review_report(void) {
  const char *names[]={"slots","constructor_names","constructor_defaults"};
  fputs("@temporary-buffers {",stderr);
  for(int i=0;i<3;i++){
    ReviewCount *c=&review_counts[i];
    fprintf(stderr,"%s\"%s\":{\"attempted\":%zu,\"allocated\":%zu,\"freed\":%zu,\"live\":%zu,\"live_bytes\":%zu,\"refused\":%zu}",
            i?",":"",names[i],c->attempted,c->allocated,c->freed,c->live,c->bytes,c->refused);
  }
#if REVIEW_CANDIDATE
  int cleared=1;
  for(size_t i=temporary_buffer_count;i<review_highwater;i++)if(temporary_buffers[i]){cleared=0;break;}
  fprintf(stderr,",\"depth\":%zu,\"discarded_slots_cleared\":%s,\"registry_calls\":%zu",temporary_buffer_count,cleared?"true":"false",review_registry_calls);
#else
  fputs(",\"depth\":null,\"discarded_slots_cleared\":null",stderr);
#endif
  fputs("}\n",stderr);
}
int main(int argc,char **argv) {
  int result;
  const char *malloc_fault=getenv("SPROUT_REVIEW_MALLOC_REFUSE");
  if(malloc_fault)review_refuse_malloc=atoi(malloc_fault);
#if REVIEW_CANDIDATE
  if(argc>1&&!strcmp(argv[1],"--tombstone-control")){result=review_tombstones();review_report();return result;}
  const char *reserve_fault=getenv("SPROUT_REVIEW_RESERVE_AFTER");
  if(reserve_fault){
    temporary_buffer_capacity=(size_t)atoi(reserve_fault);
    if(temporary_buffer_capacity){
      temporary_buffers=calloc(temporary_buffer_capacity,sizeof(void *));
      if(!temporary_buffers)return 96;
    }
    review_refuse_reserve=1;
  }
#endif
  result=reviewed_sprout_main(argc,argv);review_report();return result;
}
