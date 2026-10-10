/* Lexical formatter state crosses triple-quoted text lines without changing their content. */
typedef struct { int triple,bracket; } FmtState;
static void fmt_scan_line(FmtState *state,const char *start,const char *end) {
  int quoted=0;
  for(const char *p=start;p<end;p++) {
    if(state->triple){
      if(*p=='\\'&&p+1<end){p++;continue;}
      if(*p=='"'&&p+2<end&&p[1]=='"'&&p[2]=='"'){state->triple=0;p+=2;}
      continue;
    }
    if(quoted){if(*p=='\\'&&p+1<end)p++;else if(*p=='"')quoted=0;continue;}
    if(*p=='~')break;
    if(*p=='"'){
      if(p+2<end&&p[1]=='"'&&p[2]=='"'){state->triple=1;p+=2;}else quoted=1;
    }else if(*p=='('||*p=='['||*p=='{')state->bracket++;
    else if(*p==')'||*p==']'||*p=='}')state->bracket--;
  }
}
static char *format_source(const char *src) {
  size_t cap=strlen(src)*2+256,len=0;char *out=(char *)malloc(cap);int stack[256],sp=0;stack[0]=0;
  FmtState state={0};int blanks=0;
  for(const char *p=src;*p;) {
    const char *ls=p;while(*p&&*p!='\n')p++;const char *le=p;if(*p=='\n')p++;
    int started_text=state.triple,before_brackets=state.bracket;fmt_scan_line(&state,ls,le);
    const char *c=ls;int iw=0;while(c<le&&(*c==' '||*c=='\t')){iw+=*c=='\t'?4:1;c++;}
    const char *ce=le;
    if(!started_text&&!state.triple)while(ce>c&&(ce[-1]==' '||ce[-1]=='\t'||ce[-1]=='\r'))ce--;
    int clen=(int)(ce-c);
    if(len+(size_t)(le-ls)+1200>cap){cap=(len+(size_t)(le-ls)+1200)*2;out=(char *)realloc(out,cap);}
    if(started_text){size_t n=(size_t)(le-ls);memcpy(out+len,ls,n);len+=n;out[len++]='\n';blanks=0;continue;}
    if(before_brackets>0){if(clen>0){size_t n=(size_t)(ce-ls);memcpy(out+len,ls,n);len+=n;}out[len++]='\n';blanks=0;continue;}
    if(clen==0){if(++blanks<=1)out[len++]='\n';continue;}blanks=0;int depth;
    if(*c!='~'){while(sp>0&&iw<stack[sp])sp--;if(iw>stack[sp]&&sp<255)stack[++sp]=iw;depth=sp;}
    else {depth=sp;while(depth>0&&iw<stack[depth])depth--;}
    for(int i=0;i<depth*4;i++)out[len++]=' ';
    memcpy(out+len,c,(size_t)clen);len+=(size_t)clen;out[len++]='\n';
  }
  if(!state.triple)while(len>1&&out[len-1]=='\n'&&out[len-2]=='\n')len--;
  if(len>0&&out[len-1]!='\n')out[len++]='\n';
  out[len]=0;return out;
}
