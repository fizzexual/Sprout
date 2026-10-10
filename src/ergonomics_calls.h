/* Resolve argument names before evaluating expressions; explicit inputs run left to right. */
static int call_has_named(Expr *call) {
  for(int i=0;i<call->nargs;i++)if(call->keys&&call->keys[i])return 1;
  return 0;
}
static void builtin_positional_inputs(Expr *call) {
  if(call_has_named(call))fail_kind(call->line,"argument","builtin operations currently accept positional inputs; wrap one in a task to give its inputs names.");
}
/* Result maps parameter slots to source argument positions. -1 means default, -2 receiver. */
static int *argument_positions(const char *label,char **params,Expr **defaults,int n,int offset,Expr *call) {
  if(offset>n||call->nargs>n-offset){char msg[240];snprintf(msg,sizeof msg,"'%s' accepts at most %d inputs, but got %d.",label,n-offset,call->nargs);fail_kind(call->line,"argument",msg);}
  int *slots=(int *)malloc((size_t)(n?n:1)*sizeof(int));if(!slots)fail(call->line,"couldn't allocate task inputs.");
  for(int i=0;i<n;i++)slots[i]=i<offset?-2:-1;
  for(int i=0;i<call->nargs;i++) {
    const char *name=call->keys?call->keys[i]:NULL;int target=offset+i;
    if(name){target=-1;int matches=0;
      for(int j=offset;j<n;j++)if(!strcmp(params[j],name)){target=j;matches++;}
      if(matches!=1){char msg[260];snprintf(msg,sizeof msg,matches?"'%s' has ambiguous inputs called '%s'.":"'%s' has no input called '%s'.",label,name);free(slots);fail_kind(call->line,"argument",msg);}
    }
    if(target<offset||target>=n||slots[target]!=-1){char msg[240];snprintf(msg,sizeof msg,"the input '%s' was supplied twice.",target>=0&&target<n?params[target]:"self");free(slots);fail_kind(call->line,"argument",msg);}
    slots[target]=i;
  }
  for(int i=offset;i<n;i++)if(slots[i]==-1&&(!defaults||!defaults[i])){
    char msg[240];snprintf(msg,sizeof msg,"'%s' needs a value for '%s'.",label,params[i]);free(slots);fail_kind(call->line,"argument",msg);
  }
  return slots;
}
static Value call_task_expr(TaskDef *task,Expr *call,Env *caller,const Value *receiver) {
  int offset=receiver?1:0;
  if(!call_has_named(call))task_arity_check(task,call->nargs+offset,call->line);
  int *slots=argument_positions(task->name,task->params,task->defaults,task->nparams,offset,call);
  Env *frame=env_new(task->home);
  if(receiver){if(task->ptypes&&task->ptypes[0])check_type(*receiver,task->ptypes[0],call->line,"the receiver");env_define(frame,task->params[0],*receiver);}
  for(int arg=0;arg<call->nargs;arg++)for(int param=offset;param<task->nparams;param++)if(slots[param]==arg){
    Value value=eval(call->args[arg],caller);
    if(task->ptypes&&task->ptypes[param]){char what[160];snprintf(what,sizeof what,"the input '%s'",task->params[param]);check_type(value,task->ptypes[param],call->line,what);}
    env_define(frame,task->params[param],value);break;
  }
  for(int param=offset;param<task->nparams;param++)if(slots[param]==-1){
    Value value=eval(task->defaults[param],frame);
    if(task->ptypes&&task->ptypes[param]){char what[160];snprintf(what,sizeof what,"the input '%s'",task->params[param]);check_type(value,task->ptypes[param],call->line,what);}
    env_define(frame,task->params[param],value);
  }
  free(slots);
  if(task->owner_type)env_define(frame,"__class__",vstr(task->owner_type));
  return run_task(task,frame,call->line);
}
