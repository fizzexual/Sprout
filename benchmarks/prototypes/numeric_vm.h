/* Experimental bounded numeric-expression bytecode; AST remains the complete language runtime. */
#define NUM_VM_LIMIT 256
typedef enum { NV_CONST,NV_VAR,NV_NEG,NV_ARITH,NV_TICK } NumOp;
typedef struct { NumOp op;TokType arithmetic;int line;double value;char *name; } NumInstruction;
typedef struct { int count;NumInstruction ops[NUM_VM_LIMIT]; } NumProgram;
static unsigned long long g_num_vm_compiled=0,g_num_vm_hits=0,g_num_vm_fallbacks=0;
static void num_vm_stats(void) {
  fprintf(stderr,"SPROUT_NUMERIC_VM_PROFILE {\"compiled\":%llu,\"executions\":%llu,\"fallbacks\":%llu}\n",g_num_vm_compiled,g_num_vm_hits,g_num_vm_fallbacks);
}
static int num_vm_enabled(void) {
  static int enabled=-1;
  if(enabled<0){const char *mode=getenv("SPROUT_NUMERIC_VM");enabled=mode&&!strcmp(mode,"1");
    const char *profile=getenv("SPROUT_NUMERIC_VM_STATS");if(profile&&!strcmp(profile,"1"))atexit(num_vm_stats);}
  return enabled;
}
static int num_vm_emit(NumProgram *program,NumInstruction op) {
  if(program->count>=NUM_VM_LIMIT)return 0;
  program->ops[program->count++]=op;return 1;
}
static int num_vm_compile(Expr *expr,NumProgram *program,int root,int depth) {
  if(depth>32)return 0;
  NumInstruction op={0};op.line=expr->line;
  if(!root){op.op=NV_TICK;if(!num_vm_emit(program,op))return 0;}
  if(expr->kind==E_NUM){op.op=NV_CONST;op.value=expr->num;return num_vm_emit(program,op);}
  if(expr->kind==E_VAR){op.op=NV_VAR;op.name=expr->name;return num_vm_emit(program,op);}
  if(expr->kind==E_UNARY&&expr->op==T_MINUS){if(!num_vm_compile(expr->operand,program,0,depth+1))return 0;op.op=NV_NEG;return num_vm_emit(program,op);}
  if(expr->kind==E_BINARY&&(expr->op==T_PLUS||expr->op==T_MINUS||expr->op==T_STAR||expr->op==T_SLASH||expr->op==T_PERCENT)) {
    if(!num_vm_compile(expr->left,program,0,depth+1)||!num_vm_compile(expr->right,program,0,depth+1))return 0;
    op.op=NV_ARITH;op.arithmetic=expr->op;return num_vm_emit(program,op);
  }
  return 0;
}
static int num_vm_eval(Expr *expr,Env *env,Value *result) {
  if(expr->numeric_bytecode==(void *)1){g_num_vm_fallbacks++;return 0;}
  NumProgram *program=(NumProgram *)expr->numeric_bytecode;
  if(!program){program=(NumProgram *)calloc(1,sizeof *program);
    if(!program)return 0;
    if(!num_vm_compile(expr,program,1,0)){free(program);expr->numeric_bytecode=(void *)1;g_num_vm_fallbacks++;return 0;}
    expr->numeric_bytecode=program;g_num_vm_compiled++;
  }
  /* Check every variable before emitting ticks or effects: unsupported values fall back intact. */
  for(int i=0;i<program->count;i++)if(program->ops[i].op==NV_VAR){Value *value=env_find(env,program->ops[i].name);
    if(!value||value->type!=V_NUM){g_num_vm_fallbacks++;return 0;}program->ops[i].value=value->num;}
  double stack[NUM_VM_LIMIT];int at=0;
  for(int i=0;i<program->count;i++){NumInstruction *op=&program->ops[i];
    switch(op->op){
      case NV_TICK:runtime_tick(op->line);break;
      case NV_CONST:case NV_VAR:stack[at++]=op->value;break;
      case NV_NEG:stack[at-1]=-stack[at-1];break;
      case NV_ARITH:{double right=stack[--at],left=stack[--at];Value value=apply_arith(op->arithmetic,vnum(left),vnum(right),op->line);stack[at++]=value.num;break;}
    }
  }
  *result=vnum(stack[0]);g_num_vm_hits++;return 1;
}
