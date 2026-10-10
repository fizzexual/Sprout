/* Shared parser for task, module and method input lists. Expr.keys holds optional labels. */
static void parse_call_inputs(Expr *call) {
  Expr **args=NULL;char **names=NULL;int n=0,cap=0,named=0;
  if(!check(T_RPAREN))do {
    if(check(T_RPAREN))break;
    char *name=NULL;
    if(check(T_IDENT)&&toks[pos+1].type==T_COLON) {
      name=advance().text;advance();named=1;
      for(int i=0;i<n;i++)if(names[i]&&!strcmp(names[i],name))failf(peek().line,"the input '%s' was named twice.",name);
    }else if(named)fail(peek().line,"positional inputs must come before named inputs.");
    if(n>=cap){cap=cap?cap*2:4;args=(Expr **)realloc(args,(size_t)cap*sizeof(Expr *));names=(char **)realloc(names,(size_t)cap*sizeof(char *));}
    names[n]=name;args[n++]=expression();
  }while(match(T_COMMA));
  expect(T_RPAREN,"I expected a ')' to close the inputs.");call->args=args;call->keys=names;call->nargs=n;
}
