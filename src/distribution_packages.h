/* Reproducible packages, compatible with the original name/source manifest. */
#define PKG_DIR "sprout_packages"
#define PKG_MANIFEST "sprout.packages"
#define PKG_LOCK "sprout.lock"
#define PKG_MAX 128
typedef struct { char name[128],source[1024],path[1024],hash[65];unsigned char *data;size_t len; } PkgFile;
typedef struct { char name[128],source[1024];int visiting,done; } PkgSpec;
static PkgFile pkg_files[DIST_MAX_FILES],pkg_locked[DIST_MAX_FILES];
static int pkg_nfiles=0,pkg_nlocked=0,pkg_nspec=0;
static PkgSpec pkg_specs[PKG_MAX];
static size_t pkg_bytes=0;
static int pkg_name_valid(const char *s) {
  if(!s[0]||strlen(s)>=128||!dist_safe_path(s))return 0;
  for(const char *p=s;*p;p++)if(!isalnum((unsigned char)*p)&&*p!='_'&&*p!='-')return 0;
  return 1;
}
static char *pkg_next_line(char **cursor) {
  if(!*cursor||!**cursor)return NULL;
  char *line=*cursor,*end=strchr(line,'\n');
  if(end){*end=0;*cursor=end+1;}else *cursor=line+strlen(line);
  size_t len=strlen(line);if(len&&line[len-1]=='\r')line[len-1]=0;
  while(*line==' '||*line=='\t')line++;
  return line;
}
static int pkg_source_valid(const char *s) {
  if(!s[0]||strlen(s)>=1024)return 0;
  for(const char *p=s;*p;p++)if(isspace((unsigned char)*p))return 0;
  return 1;
}
static int pkg_github_parts(const char *source,char repo[512],char ref[256],char path[800]) {
  const char *spec=source+7,*sep=strchr(spec,':'),*at=strchr(spec,'@');
  const char *end=at?at:sep?sep:spec+strlen(spec);size_t n=(size_t)(end-spec);
  if(n==0||n>=512)return 0;
  memcpy(repo,spec,n);repo[n]=0;
  char *slash=strchr(repo,'/');if(!slash||slash==repo||!slash[1]||strchr(slash+1,'/'))return 0;
  for(char *p=repo;*p;p++)if(!isalnum((unsigned char)*p)&&*p!='/'&&*p!='-'&&*p!='_'&&*p!='.')return 0;
  strcpy(ref,"main");if(at){const char *r=at+1,*re=sep?sep:source+strlen(source);size_t rn=(size_t)(re-r);if(rn==0||rn>=256)return 0;memcpy(ref,r,rn);ref[rn]=0;}
  for(char *p=ref;*p;p++)if(!isalnum((unsigned char)*p)&&*p!='-'&&*p!='_'&&*p!='.')return 0;
  if(sep){if(!dist_safe_path(sep+1))return 0;snprintf(path,800,"%s",sep+1);}else snprintf(path,800,"%s.sprout",slash+1);
  return 1;
}
static unsigned char *pkg_fetch_bytes(const char *source,size_t *length);
static int pkg_pin_source(const char *source,char resolved[1024]) {
  if(!pkg_source_valid(source))return 0;
  if(strncmp(source,"github:",7)){strcpy(resolved,source);return 1;}
  char repo[512],ref[256],path[800];if(!pkg_github_parts(source,repo,ref,path)){fprintf(stderr,"  Invalid GitHub source; use github:owner/repo@ref[:path].\n");return 0;}
  int commit=strlen(ref)==40;for(int i=0;commit&&i<40;i++)if(!isxdigit((unsigned char)ref[i]))commit=0;
  char sha[41];if(commit){strcpy(sha,ref);for(int i=0;i<40;i++)sha[i]=(char)tolower((unsigned char)sha[i]);}
  else {
    char api[1024];snprintf(api,sizeof api,"https://api.github.com/repos/%s/commits/%s",repo,ref);
    size_t length;char *body=(char *)pkg_fetch_bytes(api,&length);if(!body){fprintf(stderr,"  Couldn't resolve GitHub ref '%s' for %s.\n",ref,repo);return 0;}
    Value v=parse_json(body);free(body);int hi=v.type==V_MAP?map_index(v.map,"sha"):-1;Value hash=hi>=0?v.map->vals[hi]:vnone();
    if(hash.type!=V_STR||strlen(hash.str)!=40){fprintf(stderr,"  GitHub did not return a commit SHA.\n");return 0;}
    for(int i=0;i<40;i++)if(!isxdigit((unsigned char)hash.str[i]))return 0;
    strcpy(sha,hash.str);
  }
  if(snprintf(resolved,1024,"github:%s@%s:%s",repo,sha,path)>=1024)return 0;
  return 1;
}
static void pkg_name_of(const char *source,char *out,size_t size) {
  if(!strncmp(source,"github:",7)){char repo[512],ref[256],path[800];if(pkg_github_parts(source,repo,ref,path)){const char *name=strchr(repo,'/')+1;if(strlen(name)<size){strcpy(out,name);return;}}out[0]=0;return;}
  const char *b=source;for(const char *p=source;*p;p++)if(*p=='/'||*p=='\\')b=p+1;
  size_t n=strlen(b);if(n>7&&!strcmp(b+n-7,".sprout"))n-=7;if(n>=size){out[0]=0;return;}memcpy(out,b,n);out[n]=0;
}
static unsigned char *pkg_fetch_bytes(const char *source,size_t *length) {
  char url[1800];const char *remote=source;
  if(!strncmp(source,"github:",7)){char repo[512],ref[256],path[800];if(!pkg_github_parts(source,repo,ref,path))return NULL;
    if(snprintf(url,sizeof url,"https://raw.githubusercontent.com/%s/%s/%s",repo,ref,path)>=(int)sizeof url)return NULL;
    remote=url;}
  if(strncmp(remote,"https://",8)&&strncmp(remote,"http://",7)){long n;unsigned char *b=read_bytes(remote,&n);if(b)*length=(size_t)n;return b;}
#ifdef __EMSCRIPTEN__
  return NULL;
#elif defined(_WIN32)
  /* WinHTTP avoids URLMON's persistent cache; package source drift must be observable. */
  PRWinHTTP h;if(!pr_http_load(&h)){if(h.library)FreeLibrary(h.library);return NULL;}
  wchar_t *wurl=pr_wide(remote),*host=NULL,*path=NULL;
  HINTERNET session=NULL,connection=NULL,request=NULL;unsigned char *bytes=NULL;size_t used=0,cap=8192;int ok=0;
  URL_COMPONENTS c;memset(&c,0,sizeof c);c.dwStructSize=sizeof c;
  c.dwHostNameLength=c.dwUrlPathLength=c.dwExtraInfoLength=c.dwUserNameLength=c.dwPasswordLength=(DWORD)-1;
  if(!wurl||!h.crack(wurl,0,0,&c)||(c.nScheme!=INTERNET_SCHEME_HTTP&&c.nScheme!=INTERNET_SCHEME_HTTPS)||c.dwUserNameLength||c.dwPasswordLength)goto pkg_http_done;
  host=(wchar_t *)calloc((size_t)c.dwHostNameLength+1,sizeof(wchar_t));path=(wchar_t *)calloc((size_t)c.dwUrlPathLength+c.dwExtraInfoLength+2,sizeof(wchar_t));
  if(!host||!path)goto pkg_http_done;
  memcpy(host,c.lpszHostName,c.dwHostNameLength*sizeof(wchar_t));
  if(c.dwUrlPathLength)memcpy(path,c.lpszUrlPath,c.dwUrlPathLength*sizeof(wchar_t));else path[0]='/';
  if(c.dwExtraInfoLength)memcpy(path+(c.dwUrlPathLength?c.dwUrlPathLength:1),c.lpszExtraInfo,c.dwExtraInfoLength*sizeof(wchar_t));
  session=h.open(L"Sprout-packages/1",WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,NULL,NULL,0);if(!session)goto pkg_http_done;
  h.timeouts(session,15000,15000,60000,60000);connection=h.connect(session,host,c.nPort,0);if(!connection)goto pkg_http_done;
  request=h.open_request(connection,L"GET",path,NULL,NULL,NULL,c.nScheme==INTERNET_SCHEME_HTTPS?WINHTTP_FLAG_SECURE:0);if(!request)goto pkg_http_done;
  if(!h.send(request,L"Cache-Control: no-cache\r\nPragma: no-cache\r\n",(DWORD)-1,NULL,0,0,0)||!h.receive(request,NULL))goto pkg_http_done;
  DWORD status=0,size=sizeof status;if(!h.query(request,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,NULL,&status,&size,NULL)||status<200||status>=300)goto pkg_http_done;
  bytes=(unsigned char *)malloc(cap+1);if(!bytes)goto pkg_http_done;unsigned long long deadline=GetTickCount64()+60000;
  for(;;){if(GetTickCount64()>=deadline)goto pkg_http_done;unsigned char block[8192];DWORD got=0;
    if(!h.read(request,block,sizeof block,&got))goto pkg_http_done;
    if(!got)break;
    if(used+got>DIST_MAX_ARCHIVE)goto pkg_http_done;
    if(used+got>cap){cap=(used+got)*2;if(cap>DIST_MAX_ARCHIVE)cap=DIST_MAX_ARCHIVE;unsigned char *grown=(unsigned char *)realloc(bytes,cap+1);if(!grown)goto pkg_http_done;bytes=grown;}
    memcpy(bytes+used,block,got);used+=got;
  }
  bytes[used]=0;*length=used;ok=1;
pkg_http_done:
  if(request)h.close(request);
  if(connection)h.close(connection);
  if(session)h.close(session);
  FreeLibrary(h.library);free(wurl);free(host);free(path);if(!ok){free(bytes);bytes=NULL;}return bytes;
#else
  char temp[1024];const char *base=getenv("TMPDIR");if(!base||!*base)base="/tmp";
  if(snprintf(temp,sizeof temp,"%s/sprout_package_XXXXXX",base)>=(int)sizeof temp)return NULL;
  int fd=mkstemp(temp);if(fd<0)return NULL;close(fd);
  size_t cap=strlen(remote)*4+strlen(temp)*4+160;char *cmd=(char *)malloc(cap);size_t at=0;
  at+=(size_t)snprintf(cmd+at,cap-at,"curl -fsSL --connect-timeout 15 --max-time 60 --max-filesize 67108864 '");
  for(const char *p=remote;*p;p++){if(*p=='\''){memcpy(cmd+at,"'\\''",4);at+=4;}else cmd[at++]=*p;}
  memcpy(cmd+at,"' -o '",6);at+=6;
  for(const char *p=temp;*p;p++){if(*p=='\''){memcpy(cmd+at,"'\\''",4);at+=4;}else cmd[at++]=*p;}
  cmd[at++]='\'';cmd[at]=0;int rc=system(cmd);free(cmd);long n=0;unsigned char *bytes=rc==0?read_bytes(temp,&n):NULL;remove(temp);if(bytes)*length=(size_t)n;return bytes;
#endif
}
static int pkg_child_source(const char *source,const char *child,char out[1024]) {
  if(!dist_safe_path(child))return 0;
  if(!strncmp(source,"github:",7)){char repo[512],ref[256],path[800];if(!pkg_github_parts(source,repo,ref,path))return 0;
    char *slash=strrchr(path,'/');if(slash)slash[1]=0;else path[0]=0;
    return snprintf(out,1024,"github:%s@%s:%s%s",repo,ref,path,child)<1024;}
  const char *slash=NULL;for(const char *p=source;*p;p++)if(*p=='/'||*p=='\\')slash=p;
  return snprintf(out,1024,"%.*s%s",slash?(int)(slash-source+1):0,source,child)<1024;
}
static int pkg_dest_valid(const char *name,const char *path) {
  if(!pkg_name_valid(name)||!dist_safe_path(path))return 0;
  char single[256],prefix[256];
  snprintf(single,sizeof single,"%s/%s.sprout",PKG_DIR,name);snprintf(prefix,sizeof prefix,"%s/%s/",PKG_DIR,name);
  return !strcmp(path,single)||!strncmp(path,prefix,strlen(prefix));
}
static int pkg_lock_load(void) {
  char *text=read_whole_file(PKG_LOCK);pkg_nlocked=0;if(!text)return 1;char *cursor=text,*line=pkg_next_line(&cursor);
  if(!line||strcmp(line,"# sprout.lock v1 sha256")){free(text);fprintf(stderr,"  Unsupported or corrupt sprout.lock.\n");return 0;}
  while((line=pkg_next_line(&cursor)))if(*line&&*line!='#') {
    if(pkg_nlocked>=DIST_MAX_FILES){free(text);return 0;}PkgFile *r=&pkg_locked[pkg_nlocked];char extra[2];
    if(sscanf(line,"%127s %1023s %64s %1023s %1s",r->name,r->source,r->hash,r->path,extra)!=4||
       !pkg_source_valid(r->source)||!dist_hex_digest(r->hash)||!pkg_dest_valid(r->name,r->path)){free(text);fprintf(stderr,"  Invalid lockfile record.\n");return 0;}
    for(int i=0;i<pkg_nlocked;i++)if(!strcmp(pkg_locked[i].path,r->path)){free(text);fprintf(stderr,"  Duplicate lockfile path.\n");return 0;}
    for(int i=0;i<64;i++)r->hash[i]=(char)tolower((unsigned char)r->hash[i]);
    pkg_nlocked++;
  }
  free(text);return 1;
}
static int pkg_file_compare(const void *a,const void *b){return strcmp(((const PkgFile *)a)->path,((const PkgFile *)b)->path);}
static int pkg_lock_write(int preserve) {
  if(preserve)for(int i=0;i<pkg_nlocked;i++) {
    int replaced=0;for(int j=0;j<pkg_nspec;j++)if(!strcmp(pkg_specs[j].name,pkg_locked[i].name))replaced=1;
    if(!replaced){if(pkg_nfiles>=DIST_MAX_FILES)return 0;pkg_files[pkg_nfiles++]=pkg_locked[i];pkg_files[pkg_nfiles-1].data=NULL;}
  }
  qsort(pkg_files,(size_t)pkg_nfiles,sizeof(PkgFile),pkg_file_compare);size_t cap=(size_t)pkg_nfiles*2400+128;
  char *text=(char *)malloc(cap);size_t at=(size_t)snprintf(text,cap,"# sprout.lock v1 sha256\n");
  for(int i=0;i<pkg_nfiles;i++){PkgFile *r=&pkg_files[i];at+=(size_t)snprintf(text+at,cap-at,"%s\t%s\t%s\t%s\n",r->name,r->source,r->hash,r->path);}
  int ok=dist_atomic_write(PKG_LOCK,(unsigned char *)text,at);free(text);return ok;
}
static int pkg_manifest_write(int preserve) {
  char *old=preserve?read_whole_file(PKG_MANIFEST):NULL;size_t cap=(old?strlen(old):0)+(size_t)pkg_nspec*1200+128;
  char *text=(char *)malloc(cap);size_t at=(size_t)snprintf(text,cap,"# Sprout packages: commit this manifest and sprout.lock.\n");
  if(old){char *cursor=old,*line;while((line=pkg_next_line(&cursor)))if(*line&&*line!='#') {
    char name[128],src[1024],extra[2];if(sscanf(line,"%127s %1023s %1s",name,src,extra)!=2){free(old);free(text);return 0;}
    int replaced=0;for(int j=0;j<pkg_nspec;j++)if(!strcmp(pkg_specs[j].name,name))replaced=1;
    if(!replaced)at+=(size_t)snprintf(text+at,cap-at,"%s %s\n",name,src);
  }free(old);}
  for(int i=0;i<pkg_nspec;i++)at+=(size_t)snprintf(text+at,cap-at,"%s %s\n",pkg_specs[i].name,pkg_specs[i].source);
  int ok=dist_atomic_write(PKG_MANIFEST,(unsigned char *)text,at);free(text);return ok;
}
static void pkg_clear_plan(void){for(int i=0;i<pkg_nfiles;i++)free(pkg_files[i].data);pkg_nfiles=0;pkg_nspec=0;pkg_bytes=0;}
static int pkg_plan_file(const char *name,const char *source,const char *dest,unsigned char *data,size_t len) {
  if(pkg_nfiles>=DIST_MAX_FILES||pkg_bytes+len>DIST_MAX_ARCHIVE||!pkg_dest_valid(name,dest)){free(data);return 0;}
  for(int i=0;i<pkg_nfiles;i++)if(!strcmp(pkg_files[i].path,dest)){free(data);fprintf(stderr,"  Duplicate package file: %s\n",dest);return 0;}
  PkgFile *r=&pkg_files[pkg_nfiles++];memset(r,0,sizeof *r);snprintf(r->name,sizeof r->name,"%s",name);snprintf(r->source,sizeof r->source,"%s",source);
  snprintf(r->path,sizeof r->path,"%s",dest);r->data=data;r->len=len;dist_shahex(data,len,r->hash);pkg_bytes+=len;return 1;
}
static int pkg_plan(const char *name,const char *source,int depth) {
  if(depth>32||!pkg_name_valid(name)||!pkg_source_valid(source)){fprintf(stderr,"  Invalid package name/source or dependency depth exceeded.\n");return 0;}
  char resolved[1024];if(!pkg_pin_source(source,resolved))return 0;
  for(int i=0;i<pkg_nspec;i++)if(!strcmp(pkg_specs[i].name,name)) {
    if(strcmp(pkg_specs[i].source,resolved)){fprintf(stderr,"  Conflicting dependency sources for '%s'.\n",name);return 0;}
    if(pkg_specs[i].visiting){fprintf(stderr,"  Circular package dependency at '%s'.\n",name);return 0;}return pkg_specs[i].done;
  }
  if(pkg_nspec>=PKG_MAX)return 0;
  int ix=pkg_nspec++;PkgSpec *spec=&pkg_specs[ix];memset(spec,0,sizeof *spec);
  snprintf(spec->name,sizeof spec->name,"%s",name);snprintf(spec->source,sizeof spec->source,"%s",resolved);spec->visiting=1;
  char manifest_source[1024];int directory=dist_dir(resolved);
  if(directory){if(snprintf(manifest_source,sizeof manifest_source,"%s/sprout.package",resolved)>=(int)sizeof manifest_source)return 0;}
  else snprintf(manifest_source,sizeof manifest_source,"%s",resolved);
  size_t mlen=strlen(manifest_source);int multi=directory||(mlen>=14&&!strcmp(manifest_source+mlen-14,"sprout.package")&&
    (mlen==14||manifest_source[mlen-15]=='/'||manifest_source[mlen-15]==':'));
  if(!multi){char dest[256];snprintf(dest,sizeof dest,"%s/%s.sprout",PKG_DIR,name);size_t len;unsigned char *data=pkg_fetch_bytes(resolved,&len);
    if(!data){fprintf(stderr,"  Couldn't fetch package '%s' from %s\n",name,resolved);return 0;}
    if(!pkg_plan_file(name,resolved,dest,data,len))return 0;
  }else {
    size_t len;unsigned char *data=pkg_fetch_bytes(manifest_source,&len);
    if(!data||memchr(data,0,len)){free(data);fprintf(stderr,"  Missing or invalid sprout.package for '%s'.\n",name);return 0;}
    char dest[1024];snprintf(dest,sizeof dest,"%s/%s/sprout.package",PKG_DIR,name);
    if(!pkg_plan_file(name,manifest_source,dest,data,len))return 0;
    char *text=dup_str((char *)data),*cursor=text,*line;char entry[800]="";int entry_count=0,entry_found=0;
    while((line=pkg_next_line(&cursor)))if(*line&&*line!='#') {
      char key[32],a[800],b[1024],extra[2];int fields=sscanf(line,"%31s %799s %1023s %1s",key,a,b,extra);
      if(!strcmp(key,"entry")||!strcmp(key,"file")) {
        if(fields!=2||!dist_safe_path(a)||!strcmp(a,"sprout.package")){free(text);fprintf(stderr,"  Unsafe or invalid package file declaration.\n");return 0;}
        if(!strcmp(key,"entry")){if(++entry_count!=1){free(text);return 0;}strcpy(entry,a);}
        char child[1024];if(!pkg_child_source(manifest_source,a,child)||snprintf(dest,sizeof dest,"%s/%s/%s",PKG_DIR,name,a)>=(int)sizeof dest){free(text);return 0;}
        size_t n;unsigned char *content=pkg_fetch_bytes(child,&n);if(!content||!pkg_plan_file(name,child,dest,content,n)){free(text);fprintf(stderr,"  Couldn't fetch declared package file '%s'.\n",a);return 0;}
      }else if(!strcmp(key,"dependency")) {
        if(fields!=3||!pkg_name_valid(a)){free(text);return 0;}char dependency[1024];
        if(!strncmp(b,"github:",7)||!strncmp(b,"https://",8)||!strncmp(b,"http://",7))snprintf(dependency,sizeof dependency,"%s",b);
        else if(!pkg_child_source(manifest_source,b,dependency)){free(text);return 0;}
        if(!pkg_plan(a,dependency,depth+1)){free(text);return 0;}
      }else {free(text);fprintf(stderr,"  Unknown sprout.package directive.\n");return 0;}
    }
    free(text);for(int i=0;i<pkg_nfiles;i++)if(!strcmp(pkg_files[i].name,name)){char wanted[1024];snprintf(wanted,sizeof wanted,"%s/%s/%s",PKG_DIR,name,entry);if(!strcmp(pkg_files[i].path,wanted))entry_found=1;}
    if(entry_count!=1||!entry_found||strlen(entry)<7||strcmp(entry+strlen(entry)-7,".sprout")){fprintf(stderr,"  Package needs exactly one .sprout entry.\n");return 0;}
  }
  spec=&pkg_specs[ix];spec->visiting=0;spec->done=1;return 1;
}
static int pkg_apply(void) {
  /* Fetching and validation finish before any installed file is changed. Writes are atomic per file. */
  for(int i=0;i<pkg_nfiles;i++)if(pkg_files[i].data&&!dist_atomic_write(pkg_files[i].path,pkg_files[i].data,pkg_files[i].len)) {
    fprintf(stderr,"  Couldn't safely write %s\n",pkg_files[i].path);return 0;
  }
  return 1;
}
static int cmd_add(int argc,char **argv) {
  console_setup();if(argc<3||argc>4){fprintf(stderr,"  Usage: sprout add <path|directory|https-url|github:owner/repo@ref[:path]> [name]\n");return 1;}
  char name[128];if(argc==4){if(!pkg_name_valid(argv[3])){fprintf(stderr,"  Invalid package name; use at most 127 letters, digits, '-' or '_'.\n");return 1;}strcpy(name,argv[3]);}else pkg_name_of(argv[2],name,sizeof name);
  if(!pkg_name_valid(name)||!pkg_source_valid(argv[2])){fprintf(stderr,"  Package names must use letters, digits, '-' or '_'; sources cannot contain whitespace.\n");return 1;}
  if(!pkg_lock_load())return 1;
  int ok=pkg_plan(name,argv[2],0)&&pkg_apply()&&pkg_manifest_write(1)&&pkg_lock_write(1);
  if(ok)printf("  Added and locked package %s. Use it with: use %s\n",name,name);
  pkg_clear_plan();return ok?0:1;
}
static int pkg_lock_matches_manifest(const char *name,const char *source) {
  /* For trees the manifest names their directory while the first record names sprout.package. */
  for(int i=0;i<pkg_nlocked;i++)if(!strcmp(pkg_locked[i].name,name)) {
    char expected[1024];snprintf(expected,sizeof expected,"%s/%s.sprout",PKG_DIR,name);
    if(!strcmp(expected,pkg_locked[i].path))return !strcmp(source,pkg_locked[i].source);
    snprintf(expected,sizeof expected,"%s/%s/sprout.package",PKG_DIR,name);
    if(!strcmp(expected,pkg_locked[i].path)){char folder[1100];snprintf(folder,sizeof folder,"%s/sprout.package",source);
      return !strcmp(source,pkg_locked[i].source)||!strcmp(folder,pkg_locked[i].source);}
  }
  return 0;
}
static int pkg_complete_lock(void) {
  /* A syntactically valid lock must also enumerate every file in each tree manifest. */
  for(int i=0;i<pkg_nfiles;i++) {
    PkgFile *manifest=&pkg_files[i];char expected[1024];
    snprintf(expected,sizeof expected,"%s/%.127s/sprout.package",PKG_DIR,manifest->name);
    if(strcmp(expected,manifest->path))continue;
    if(memchr(manifest->data,0,manifest->len))return 0;
    char *text=dup_str((char *)manifest->data),*cursor=text,*line;int count=1,entries=0,ok=1;
    while((line=pkg_next_line(&cursor)))if(*line&&*line!='#') {
      char key[32],file[800],src[1024],extra[2];int fields=sscanf(line,"%31s %799s %1023s %1s",key,file,src,extra);
      if(!strcmp(key,"entry")||!strcmp(key,"file")) {
        if(fields!=2||!dist_safe_path(file)||!strcmp(file,"sprout.package")){ok=0;break;}
        if(!strcmp(key,"entry"))entries++;
        if(snprintf(expected,sizeof expected,"%s/%s/%s",PKG_DIR,manifest->name,file)>=(int)sizeof expected){ok=0;break;}
        char child[1024];if(!pkg_child_source(manifest->source,file,child)){ok=0;break;}int found=0;
        for(int j=0;j<pkg_nfiles;j++)if(!strcmp(pkg_files[j].path,expected)&&!strcmp(pkg_files[j].source,child))found++;
        if(found!=1){ok=0;break;}count++;
      }else if(!strcmp(key,"dependency")) {
        if(fields!=3||!pkg_name_valid(file)){ok=0;break;}int found=0;
        for(int j=0;j<pkg_nfiles;j++)if(!strcmp(pkg_files[j].name,file))found=1;
        if(!found){ok=0;break;}
      }else {ok=0;break;}
    }
    free(text);int actual=0;for(int j=0;j<pkg_nfiles;j++)if(!strcmp(pkg_files[j].name,manifest->name))actual++;
    if(!ok||entries!=1||actual!=count){fprintf(stderr,"  Incomplete or inconsistent lock for package '%s'.\n",manifest->name);return 0;}
  }
  /* Single-file names must not acquire additional unlisted files. */
  for(int i=0;i<pkg_nfiles;i++) {
    char single[256];snprintf(single,sizeof single,"%s/%.127s.sprout",PKG_DIR,pkg_files[i].name);
    if(!strcmp(single,pkg_files[i].path))for(int j=0;j<pkg_nfiles;j++)
      if(i!=j&&!strcmp(pkg_files[i].name,pkg_files[j].name)){fprintf(stderr,"  Inconsistent single-file package lock.\n");return 0;}
  }
  return 1;
}
static int cmd_install(int argc,char **argv) {
  console_setup();int strict=0;for(int i=2;i<argc;i++)if(!strcmp(argv[i],"--locked"))strict=1;else {fprintf(stderr,"  Unknown install argument: %s\n",argv[i]);return 1;}
  int has_lock=path_exists(PKG_LOCK);if(strict&&!has_lock){fprintf(stderr,"  --locked requires sprout.lock. Run sprout install once and commit it.\n");return 1;}
  char *text=read_whole_file(PKG_MANIFEST);if(!text){fprintf(stderr,"  No sprout.packages; add a package first.\n");return 1;}
  if(!pkg_lock_load()){free(text);return 1;}char *cursor=text,*line;int ok=1,count=0;
  char names[PKG_MAX][128];
  while((line=pkg_next_line(&cursor)))if(*line&&*line!='#') {
    char name[128],source[1024],extra[2];if(count>=PKG_MAX||sscanf(line,"%127s %1023s %1s",name,source,extra)!=2||!pkg_name_valid(name)||!pkg_source_valid(source)){ok=0;break;}
    for(int i=0;i<count;i++)if(!strcmp(names[i],name))ok=0;
    if(!ok)break;
    strcpy(names[count++],name);
    if(has_lock){if(!pkg_lock_matches_manifest(name,source)){fprintf(stderr,"  Manifest and lock disagree for '%s'. Re-add it explicitly to update.\n",name);ok=0;break;}}
    else if(!pkg_plan(name,source,0)){ok=0;break;}
  }
  free(text);
  if(ok&&has_lock) {
    for(int i=0;i<pkg_nlocked;i++) {
      PkgFile *r=&pkg_locked[i];int declared=0;for(int j=0;j<count;j++)if(!strcmp(names[j],r->name))declared=1;
      if(!declared){fprintf(stderr,"  Lock contains undeclared package '%s'.\n",r->name);ok=0;break;}
      if(!dist_no_links(r->path)){fprintf(stderr,"  Unsafe installed package path: %s\n",r->path);ok=0;break;}
      size_t len=0;unsigned char *data=NULL;long n=0;
      if(path_exists(r->path)){data=read_bytes(r->path,&n);len=(size_t)n;}
      else data=pkg_fetch_bytes(r->source,&len);
      if(!data){fprintf(stderr,"  Couldn't restore locked file: %s\n",r->path);ok=0;break;}
      char hash[65];dist_shahex(data,len,hash);
      if(strcmp(hash,r->hash)){free(data);fprintf(stderr,"  Checksum mismatch: %s (remove tampered files or restore the pinned source).\n",r->path);ok=0;break;}
      if(!pkg_plan_file(r->name,r->source,r->path,data,len)){ok=0;break;}
    }
  }
  if(ok&&has_lock)ok=pkg_complete_lock();
  if(ok)ok=pkg_apply();
  if(ok&&!has_lock)ok=pkg_manifest_write(0)&&pkg_lock_write(0);
  if(ok)printf("  Verified and installed %d packages%s.\n",count,has_lock?" from sprout.lock":"; created sprout.lock");
  else fprintf(stderr,"  Package installation failed; the lockfile was not changed.\n");
  pkg_clear_plan();return ok?0:1;
}
static int cmd_remove(int argc,char **argv) {
  console_setup();if(argc!=3||!pkg_name_valid(argv[2])){fprintf(stderr,"  Usage: sprout remove <name>\n");return 1;}
  if(!pkg_lock_load())return 1;
  const char *name=argv[2];char *old=read_whole_file(PKG_MANIFEST);int found=0;
  size_t cap=(old?strlen(old):0)+128;char *updated=(char *)malloc(cap);size_t at=0;
  if(old){char *cursor=old,*line;while((line=pkg_next_line(&cursor))) {char n[128]="";sscanf(line,"%127s",n);
    if(!strcmp(n,name))found=1;else at+=(size_t)snprintf(updated+at,cap-at,"%s\n",line);}free(old);}
  for(int i=0;i<pkg_nlocked;i++)if(!strcmp(pkg_locked[i].name,name)) {
    found=1;if(!dist_no_links(pkg_locked[i].path)){free(updated);fprintf(stderr,"  Refusing unsafe package removal.\n");return 1;}
  }
  if(!found){free(updated);fprintf(stderr,"  No package called '%s'.\n",name);return 1;}
  if(!dist_atomic_write(PKG_MANIFEST,(unsigned char *)updated,at)){free(updated);return 1;}free(updated);
  for(int i=0;i<pkg_nlocked;i++)if(!strcmp(pkg_locked[i].name,name)) {
    char full[1024];snprintf(full,sizeof full,"%s",pkg_locked[i].path);remove(full);
    char prefix[256];snprintf(prefix,sizeof prefix,"%s/%s",PKG_DIR,name);char *slash=strrchr(full,'/');
    while(slash&&slash>=full+strlen(prefix)){*slash=0;dist_rmdir(full);slash=strrchr(full,'/');}
  }else {pkg_files[pkg_nfiles++]=pkg_locked[i];pkg_files[pkg_nfiles-1].data=NULL;}
  /* Legacy projects may not have had a lockfile yet. */
  char single[256];snprintf(single,sizeof single,"%s/%s.sprout",PKG_DIR,name);if(dist_no_links(single))remove(single);
  int ok=pkg_lock_write(0);pkg_clear_plan();if(ok)printf("  Removed package %s.\n",name);return ok?0:1;
}
