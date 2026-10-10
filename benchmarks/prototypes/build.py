"""Build the measured numeric-expression VM experiment in a temporary source copy."""
import argparse
import os
import pathlib
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cc', default='cc')
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    source = (root / 'src/sprout.c').read_text(encoding='utf-8')
    replacements = [
        ('  TaskDef *lambda;                        /* E_LAMBDA:',
         '  void *numeric_bytecode;                /* experimental cached numeric expression program */\n'
         '  TaskDef *lambda;                        /* E_LAMBDA:'),
        ('static Value eval(Expr *e, Env *env) {\n  runtime_tick(e->line);',
         '#include "numeric_vm.h"\n\nstatic Value eval(Expr *e, Env *env) {\n  runtime_tick(e->line);'),
        ('  if (stack_too_deep()) fail(e->line, "this is nested too deeply.");\n  switch (e->kind) {',
         '  if (stack_too_deep()) fail(e->line, "this is nested too deeply.");\n'
         '  if ((e->kind == E_BINARY || e->kind == E_UNARY) && num_vm_enabled()) { Value result; if (num_vm_eval(e, env, &result)) return result; }\n'
         '  switch (e->kind) {'),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise SystemExit('Runtime layout changed; prototype integration needs review. Source was not modified.')
        source = source.replace(old, new, 1)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sprout-vm-build-') as directory:
        copy = pathlib.Path(directory) / 'sprout.c'
        copy.write_text(source, encoding='utf-8')
        command = [args.cc, '-O2', '-Wall', '-I', str(root / 'src'), '-I', str(root / 'benchmarks/prototypes'),
                   '-o', str(output), str(copy), '-lm']
        if os.name == 'nt':
            command.extend(['-Wl,--stack,67108864', '-lurlmon'])
        env = os.environ.copy()
        if pathlib.Path(args.cc).is_absolute():
            env['PATH'] = str(pathlib.Path(args.cc).parent) + os.pathsep + env['PATH']
        subprocess.run(command, check=True, cwd=root, env=env)
    print('Experimental prototype:', output)


if __name__ == '__main__':
    main()
