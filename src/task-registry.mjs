import { StopError } from './utils.mjs';
export const taskRegistry = Object.freeze({
  'erp-deactivation': () => import('./erp-cli.mjs'),
  'workforce-access': () => import('./workforce-cli.mjs').then(module => module.main())
});
export function selectTask(argv) {
  let task = 'erp-deactivation', specified = false;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--') { args.push(...argv.slice(index)); break; }
    if (value === '--task' || value.startsWith('--task=')) {
      if (specified) throw new StopError('TASK_INPUT', 'Specify --task only once.');
      specified = true;
      task = value === '--task' ? argv[++index] : value.slice(7);
    } else args.push(value);
  }
  if (!Object.hasOwn(taskRegistry, task)) throw new StopError('UNKNOWN_TASK', `Use --task ${Object.keys(taskRegistry).join(' or --task ')}.`);
  return { task, args };
}
