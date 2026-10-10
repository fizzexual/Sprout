/* v2 bundles contain a deterministic, checksummed project archive. v1 remains readable. */
#include "distribution_common.h"
#define SB_MAGIC "SPROUT_BUNDLE_01"
#define SB_MAGIC_V2 "SPROUT_BUNDLE_02"
#define SB_MAGIC_LEN 16
#define SB_TRAILER 24
#define DIST_MAX_FILES 1024
#define DIST_MAX_ARCHIVE (64u << 20)
typedef struct { char *path; unsigned char *data; size_t len; } DistFile;
static DistFile g_dist_files[DIST_MAX_FILES];
static int g_dist_count=0;
static size_t g_dist_size=0;
static char *g_dist_root=NULL;
static char *g_bundle_temp=NULL;
static char *g_bundle_entry=NULL;

static char *self_exe_path(void) {
#ifdef _WIN32
  char buf[1024];DWORD n=GetModuleFileNameA(NULL,buf,sizeof buf);return n&&n<sizeof buf?dup_str(buf):NULL;
#elif defined(__APPLE__)
  char buf[4096];uint32_t n=sizeof buf;return _NSGetExecutablePath(buf,&n)==0?dup_str(buf):NULL;
#else
  char buf[4096];ssize_t n=readlink("/proc/self/exe",buf,sizeof buf-1);if(n<=0)return NULL;buf[n]=0;return dup_str(buf);
#endif
}
static int dist_chdir(const char *p) {
#ifdef _WIN32
  return SetCurrentDirectoryA(p)?0:-1;
#else
  return chdir(p);
#endif
}
static void dist_rmdir(const char *p) {
#ifdef _WIN32
  RemoveDirectoryA(p);
#else
  rmdir(p);
#endif
}
/* Delete only the files and empty parents we extracted, never recursively follow a path. */
static void bundle_cleanup(void) {
  if(!g_bundle_temp)return;
#ifdef _WIN32
  SetCurrentDirectoryA(getenv("TEMP")?getenv("TEMP"):"C:\\");
#else
  chdir("/");
#endif
  for(int i=g_dist_count-1;i>=0;i--) {
    char full[1024];snprintf(full,sizeof full,"%s/%s",g_bundle_temp,g_dist_files[i].path);remove(full);
    char *slash=strrchr(full,'/');
    while(slash&&slash>full+strlen(g_bundle_temp)){*slash=0;dist_rmdir(full);slash=strrchr(full,'/');}
  }
  dist_rmdir(g_bundle_temp);
}
static void bundle_corrupt(const char *why) {fprintf(stderr,"  Invalid Sprout bundle: %s\n",why);exit(1);}
static char *bundle_tempdir(void) {
  char p[1024];
#ifdef _WIN32
  char base[MAX_PATH];DWORD n=GetTempPathA(sizeof base,base);if(!n||n>=sizeof base)return NULL;
  for(unsigned i=0;i<100;i++) {
    snprintf(p,sizeof p,"%ssprout_bundle_%lu_%lu_%u",base,(unsigned long)GetCurrentProcessId(),(unsigned long)GetTickCount(),i);
    if(CreateDirectoryA(p,NULL))return dup_str(p);
  }
  return NULL;
#else
  const char *base=getenv("TMPDIR");if(!base||!*base)base="/tmp";
  if(snprintf(p,sizeof p,"%s/sprout_bundle_XXXXXX",base)>=(int)sizeof p)return NULL;
  return mkdtemp(p)?dup_str(p):NULL;
#endif
}
static char *embedded_script(void) {
  char *exe=self_exe_path();if(!exe)return NULL;FILE *f=fopen(exe,"rb");free(exe);if(!f)return NULL;
  if(fseek(f,0,SEEK_END)!=0){fclose(f);return NULL;}long total=ftell(f);
  if(total<SB_TRAILER){fclose(f);return NULL;}unsigned char tail[SB_TRAILER];
  if(fseek(f,total-SB_TRAILER,SEEK_SET)!=0||fread(tail,1,sizeof tail,f)!=sizeof tail){fclose(f);return NULL;}
  int v2=!memcmp(tail,SB_MAGIC_V2,SB_MAGIC_LEN),v1=!memcmp(tail,SB_MAGIC,SB_MAGIC_LEN);
  if(!v1&&!v2){fclose(f);return NULL;}
  uint64_t length=dist_read_u64(tail+SB_MAGIC_LEN);
  if(!length||length>DIST_MAX_ARCHIVE||length>(uint64_t)(total-SB_TRAILER)){fclose(f);bundle_corrupt("invalid archive size");}
  unsigned char *archive=(unsigned char *)malloc((size_t)length+1);if(!archive){fclose(f);bundle_corrupt("out of memory");}
  fseek(f,total-SB_TRAILER-(long)length,SEEK_SET);size_t got=fread(archive,1,(size_t)length,f);fclose(f);
  if(got!=(size_t)length)bundle_corrupt("truncated archive");
  archive[length]=0;
  if(v1)return (char *)archive;
  size_t at=0;uint64_t entrylen,count;
  if(length<16)bundle_corrupt("missing archive header");
  entrylen=dist_read_u64(archive);at=8;
  if(!entrylen||entrylen>=800||entrylen>length-at)bundle_corrupt("invalid entry path");
  g_bundle_entry=(char *)malloc((size_t)entrylen+1);memcpy(g_bundle_entry,archive+at,(size_t)entrylen);g_bundle_entry[entrylen]=0;at+=(size_t)entrylen;
  if(strlen(g_bundle_entry)!=(size_t)entrylen||!dist_safe_path(g_bundle_entry)||length-at<8)bundle_corrupt("unsafe entry path");
  count=dist_read_u64(archive+at);at+=8;if(!count||count>DIST_MAX_FILES)bundle_corrupt("too many files");
  /* Validate the entire archive before creating any files. */
  for(uint64_t i=0;i<count;i++) {
    if(length-at<48)bundle_corrupt("truncated file header");
    uint64_t plen=dist_read_u64(archive+at),size=dist_read_u64(archive+at+8);unsigned char *sha=archive+at+16;at+=48;
    if(!plen||plen>=800||plen>length-at)bundle_corrupt("invalid file path");
    char *path=(char *)malloc((size_t)plen+1);memcpy(path,archive+at,(size_t)plen);path[plen]=0;at+=(size_t)plen;
    if(strlen(path)!=(size_t)plen||!dist_safe_path(path))bundle_corrupt("unsafe file path");
    if(i&&strcmp(g_dist_files[i-1].path,path)>=0)bundle_corrupt("duplicate or unsorted file path");
#ifdef _WIN32
    for(uint64_t j=0;j<i;j++)if(!_stricmp(g_dist_files[j].path,path))bundle_corrupt("case-colliding file paths");
#endif
    if(size>length-at)bundle_corrupt("truncated file data");
    unsigned char hash[32];dist_sha256(archive+at,(size_t)size,hash);
    if(memcmp(hash,sha,32))bundle_corrupt("file checksum mismatch");
    g_dist_files[i].path=path;g_dist_files[i].data=archive+at;g_dist_files[i].len=(size_t)size;g_dist_count++;at+=(size_t)size;
  }
  if(at!=(size_t)length)bundle_corrupt("trailing archive data");
  char *source=NULL;
  for(int i=0;i<g_dist_count;i++)if(!strcmp(g_dist_files[i].path,g_bundle_entry)) {
    if(memchr(g_dist_files[i].data,0,g_dist_files[i].len))bundle_corrupt("entry contains a zero byte");
    source=(char *)malloc(g_dist_files[i].len+1);memcpy(source,g_dist_files[i].data,g_dist_files[i].len);source[g_dist_files[i].len]=0;
  }
  if(!source)bundle_corrupt("entry file is missing");
  g_bundle_temp=bundle_tempdir();if(!g_bundle_temp)bundle_corrupt("could not create temporary project");atexit(bundle_cleanup);
  for(int i=0;i<g_dist_count;i++) {
    char full[1024];if(snprintf(full,sizeof full,"%s/%s",g_bundle_temp,g_dist_files[i].path)>=(int)sizeof full||
      !dist_write(full,g_dist_files[i].data,g_dist_files[i].len))bundle_corrupt("could not extract project file");
  }
  if(dist_chdir(g_bundle_temp)!=0)bundle_corrupt("could not open extracted project");
  free(archive);return source;
}
static void dist_clear(void) {
  for(int i=0;i<g_dist_count;i++){free(g_dist_files[i].path);free(g_dist_files[i].data);}
  g_dist_count=0;g_dist_size=0;
}
static char *dist_project_relative(const char *path) {
  char *full=canon_path(path);for(char *p=full;*p;p++)if(*p=='\\')*p='/';
  size_t rootlen=strlen(g_dist_root);
  if(strncmp(full,g_dist_root,rootlen)||full[rootlen]!='/'||!dist_safe_path(full+rootlen+1)) {free(full);return NULL;}
#ifdef _WIN32
  /* _fullpath does not resolve junctions: reject reparse points in every input component. */
  char check[1024];snprintf(check,sizeof check,"%s",full);
  for(char *p=check+rootlen+1;;p++)if(*p=='/'||!*p){char saved=*p;*p=0;DWORD a=GetFileAttributesA(check);*p=saved;
    if(a!=INVALID_FILE_ATTRIBUTES&&(a&FILE_ATTRIBUTE_REPARSE_POINT)){free(full);return NULL;}if(!saved)break;}
#endif
  char *relative=dup_str(full+rootlen+1);free(full);return relative;
}
static int bundle_collect(const char *path,int source);
static int bundle_package_files(const char *relative) {
  const char *prefix="sprout_packages/";
  if(strncmp(relative,prefix,strlen(prefix)))return 1;
  const char *slash=strchr(relative+strlen(prefix),'/');if(!slash)return 1;
  char root[900],manifest[1024];snprintf(root,sizeof root,"%.*s",(int)(slash-relative),relative);
  snprintf(manifest,sizeof manifest,"%s/sprout.package",root);
  if(!path_exists(manifest))return 1;
  if(!bundle_collect(manifest,0))return 0;
  char *text=read_whole_file(manifest);if(!text)return 0;char *line=text;int ok=1;
  while(line&&*line) {
    char *next=strchr(line,'\n');if(next)*next++=0;
    char key[32],file[800],extra[2];int n=sscanf(line,"%31s %799s %1s",key,file,extra);
    if(n>=1&&(!strcmp(key,"entry")||!strcmp(key,"file"))) {
      if(n!=2||!dist_safe_path(file)){ok=0;break;}
      char full[1024];if(snprintf(full,sizeof full,"%s/%s",root,file)>=(int)sizeof full){ok=0;break;}
      size_t len=strlen(file);int sourcefile=len>7&&!strcmp(file+len-7,".sprout");
      if(!bundle_collect(full,sourcefile)){ok=0;break;}
    }
    line=next;
  }
  free(text);return ok;
}
static int bundle_collect(const char *path,int source) {
  char *relative=dist_project_relative(path);
  if(!relative){fprintf(stderr,"  Bundle input escapes the project or has an unsafe path: %s\n",path);return 0;}
  for(int i=0;i<g_dist_count;i++)if(!strcmp(g_dist_files[i].path,relative)){free(relative);return 1;}
  if(g_dist_count>=DIST_MAX_FILES){free(relative);fprintf(stderr,"  Bundle exceeds %d files.\n",DIST_MAX_FILES);return 0;}
  long length;unsigned char *data=read_bytes(path,&length);
  if(!data){fprintf(stderr,"  Couldn't read bundle input: %s\n",path);free(relative);return 0;}
  if(g_dist_size+(size_t)length+strlen(relative)+48>DIST_MAX_ARCHIVE){free(data);free(relative);fprintf(stderr,"  Bundle exceeds 64 MiB.\n");return 0;}
  int ix=g_dist_count++;g_dist_files[ix].path=relative;g_dist_files[ix].data=data;g_dist_files[ix].len=(size_t)length;
  g_dist_size+=(size_t)length+strlen(relative)+48;
  if(!source)return 1;
  if(!bundle_package_files(relative))return 0;
  if(memchr(data,0,(size_t)length)){fprintf(stderr,"  Source contains a zero byte: %s\n",path);return 0;}
  const char *previous=g_current_file;g_current_file=path;ntok=0;pos=0;tokenize((char *)data,(int)length);
  char **imports=NULL;int nimports=0;
  for(int i=0;i+1<ntok;i++)if(toks[i].type==T_USE&&(toks[i+1].type==T_IDENT||toks[i+1].type==T_STR)) {
    imports=(char **)realloc(imports,(size_t)(nimports+1)*sizeof(char *));imports[nimports++]=dup_str(toks[i+1].text);
  }
  pos=0;int n;parse_program(&n); /* validate without executing */
  int ok=1;
  for(int i=0;i<nimports;i++) {
    char *base=module_basename(imports[i]);int builtin=is_builtin_module(base);free(base);
    if(!builtin) {char *p=resolve_module(imports[i]);if(!p){fprintf(stderr,"  Missing imported module '%s' in %s\n",imports[i],path);ok=0;}
      else {if(!bundle_collect(p,1))ok=0;free(p);}}
    free(imports[i]);
  }
  free(imports);g_current_file=previous;return ok;
}
static int dist_file_compare(const void *a,const void *b){return strcmp(((const DistFile *)a)->path,((const DistFile *)b)->path);}
static int bundle_write_num(FILE *f,uint64_t n){unsigned char b[8];dist_u64(b,n);return fwrite(b,1,8,f)==8;}
static int cmd_bundle(int argc,char **argv) {
  console_setup();if(argc<3){fprintf(stderr,"  Usage: sprout bundle <file.sprout> [-o output] [--asset relative/file]\n");return 1;}
  const char *script=argv[2],*out=NULL;char outbuf[1024];
  for(int i=3;i<argc;i++)if(!strcmp(argv[i],"-o")){if(++i>=argc){fprintf(stderr,"  -o needs an output path.\n");return 1;}out=argv[i];}
    else if(!strcmp(argv[i],"--asset")){if(++i>=argc){fprintf(stderr,"  --asset needs a project-relative file.\n");return 1;}}
    else {fprintf(stderr,"  Unknown bundle argument: %s\n",argv[i]);return 1;}
  if(!out){char *base=module_basename(script);snprintf(outbuf,sizeof outbuf,"%s%s",base,
#ifdef _WIN32
    ".exe"
#else
    ""
#endif
  );free(base);out=outbuf;}
#ifdef _WIN32
  else if(strlen(out)<4||strcmp(out+strlen(out)-4,".exe")){if(snprintf(outbuf,sizeof outbuf,"%s.exe",out)>=(int)sizeof outbuf)return 1;out=outbuf;}
#endif
  g_dist_root=canon_path(".");for(char *p=g_dist_root;*p;p++)if(*p=='\\')*p='/';
  char *entry=dist_project_relative(script);if(!entry){fprintf(stderr,"  Run bundle from the project root; the entry must stay inside it.\n");free(g_dist_root);return 1;}
  sjmp_buf jb;err_jmp=&jb;g_top_jmp=&jb;
  if(SJSET(jb)!=0){err_jmp=NULL;g_top_jmp=NULL;dist_clear();free(entry);free(g_dist_root);return 1;}
  toml_load();int ok=bundle_collect(script,1);
  if(path_exists("sprout.toml"))ok=bundle_collect("sprout.toml",0)&&ok;
  for(int i=0;i<g_ninc;i++)ok=bundle_collect(g_incpath[i],1)&&ok;
  for(int i=0;i<g_nassets;i++)ok=bundle_collect(g_assetpath[i],0)&&ok;
  for(int i=3;i<argc;i++)if(!strcmp(argv[i],"--asset"))ok=bundle_collect(argv[++i],0)&&ok;
  err_jmp=NULL;g_top_jmp=NULL;g_current_file=NULL;
  char *self=self_exe_path();long ilen=0;unsigned char *interp=self?read_bytes(self,&ilen):NULL;
  if(!interp)ok=0;
  char *outc=canon_path(out);
  if(self){char *selfc=canon_path(self);if(!strcmp(selfc,outc)){fprintf(stderr,"  Refusing to overwrite the running interpreter.\n");ok=0;}free(selfc);free(self);}
  for(int i=0;i<g_dist_count;i++){char *filec=canon_path(g_dist_files[i].path);if(!strcmp(filec,outc)){fprintf(stderr,"  Refusing to overwrite a project input.\n");ok=0;}free(filec);}free(outc);
  if(!ok){free(interp);dist_clear();free(entry);free(g_dist_root);return 1;}
  if(ilen>=SB_TRAILER&&(!memcmp(interp+ilen-SB_TRAILER,SB_MAGIC,16)||!memcmp(interp+ilen-SB_TRAILER,SB_MAGIC_V2,16))) {
    uint64_t old=dist_read_u64(interp+ilen-8);if(old>(uint64_t)(ilen-SB_TRAILER)){free(interp);dist_clear();free(entry);free(g_dist_root);return 1;}ilen-=(long)old+SB_TRAILER;
  }
  qsort(g_dist_files,(size_t)g_dist_count,sizeof(DistFile),dist_file_compare);
  size_t archive=16+strlen(entry)+g_dist_size;
  if(archive>DIST_MAX_ARCHIVE){fprintf(stderr,"  Complete bundle archive exceeds 64 MiB.\n");free(interp);dist_clear();free(entry);free(g_dist_root);return 1;}
  FILE *f=fopen(out,"wb");if(!f){fprintf(stderr,"  Couldn't create %s\n",out);free(interp);dist_clear();free(entry);free(g_dist_root);return 1;}
  ok=fwrite(interp,1,(size_t)ilen,f)==(size_t)ilen;
  ok=bundle_write_num(f,strlen(entry))&&ok;ok=fwrite(entry,1,strlen(entry),f)==strlen(entry)&&ok;ok=bundle_write_num(f,(uint64_t)g_dist_count)&&ok;
  for(int i=0;i<g_dist_count;i++){DistFile *r=&g_dist_files[i];unsigned char hash[32];dist_sha256(r->data,r->len,hash);
    ok=bundle_write_num(f,strlen(r->path))&&ok;ok=bundle_write_num(f,r->len)&&ok;ok=fwrite(hash,1,32,f)==32&&ok;
    ok=fwrite(r->path,1,strlen(r->path),f)==strlen(r->path)&&ok;ok=fwrite(r->data,1,r->len,f)==r->len&&ok;}
  ok=fwrite(SB_MAGIC_V2,1,16,f)==16&&ok;ok=bundle_write_num(f,(uint64_t)archive)&&ok;if(fclose(f)!=0)ok=0;
  free(interp);free(entry);free(g_dist_root);int count=g_dist_count;dist_clear();
  if(!ok){remove(out);fprintf(stderr,"  Failed writing complete bundle.\n");return 1;}
#ifndef _WIN32
  if(chmod(out,0755)!=0){fprintf(stderr,"  Couldn't make bundle executable.\n");return 1;}
#endif
  printf("  Bundled %s and %d project files into %s.\n",script,count,out);return 0;
}
