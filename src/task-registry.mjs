import { StopError } from './utils.mjs';
export const taskRegistry = Object.freeze({
  'erp-deactivation': () => import('./erp-cli.mjs').then(module => module.main()),
  'deposit-refundability': () => import('./deposit-cli.mjs').then(module => module.main()),
  'workforce-access': () => import('./workforce-cli.mjs').then(module => module.main()),
  'procare-subscriber-synchronization': () => import('./subscriber-sync-cli.mjs').then(module => module.main())
});
// Public task metadata drives the dashboard and generic execution form.
// Each new task is registered here and dispatched by the shared task runner.
export const taskCatalog = Object.freeze([
  {
    id: 'erp-deactivation', name: 'ERP employee deactivation',
    description: 'Collect the current employees of an eligible partner in Procare, then preview or verify staging CoreHR deactivations.',
    applications: ['Procare', 'CoreHR'], environments: ['staging'], modes: ['preview', 'apply'],
    availability: 'Staging only. Manual SSO or MFA may require the operator in the opened browser.',
    inputs: [
      { name: 'partner', label: 'Exact partner name', type: 'text', required: true, maxLength: 200,
        placeholder: 'Enter the exact staging partner name', help: 'The partner must be Terminated or Inactive.' },
      { name: 'pagination', label: 'Employee collection', type: 'select', required: true,
        defaultValue: 'auto', options: [{ value: 'auto', label: 'All pages automatically' }],
        help: 'The complete list is recollected on every run. Guided pagination remains available through the CLI.' }
    ]
  },
  {
    id: 'deposit-refundability', name: 'Deposit refundability',
    description: 'Paste exact usernames to preview and change eligible security deposits in the selected tenant, without Google Sheets.',
    applications: ['phpMyAdmin'], environments: ['production-manual', 'offline-demo'], modes: ['preview', 'apply'],
    availability: 'Live manual input changes real deposits after preview and confirmation. Google Sheets is skipped. Offline demo uses synthetic records.',
    inputs: [
      { name: 'usernames', label: 'Usernames', type: 'textarea', required: true, maxLength: 2600,
        placeholder: 'One exact username per line', help: 'Up to 20 usernames, one per line. Use a separate live run for each tenant. Offline demo users: demo.north and demo.south.' },
      { name: 'tenant', label: 'Tenant', type: 'select', required: false, defaultValue: '',
        options: [{ value: '', label: 'Select tenant (demo can detect from fixture sheets)' }, { value: 'north', label: 'North / Delhi' }, { value: 'south', label: 'South / Hyderabad' }],
        help: 'Required for live manual input. Choose the tenant that owns these users; Google Sheets is not consulted.' },
      { name: 'refundable', label: 'Target refundable value', type: 'select', required: true, defaultValue: '1',
        options: [{ value: '1', label: '1 — Refundable' }, { value: '0', label: '0 — Non-refundable' }],
        help: 'Only uncovered, unbundled deposits are changed. Deposits already at the target are skipped.' }
    ]
  },
  {
    id: 'workforce-access', name: 'Workforce Sales group access',
    description: 'Preview, grant or remove exact membership in the first Sales User Group for an approved North, South or both-tenant request.',
    applications: ['Portal', 'Workforce'], environments: ['staging'], modes: ['preview', 'apply'],
    availability: 'Staging only. Grant or removal affects this group membership; other groups and account state are unchanged.',
    inputs: [
      { name: 'usernames', label: 'Usernames', type: 'textarea', required: true, maxLength: 2600,
        placeholder: 'One exact username per line', help: 'Up to 20 exact usernames. The selected tenant is required and never guessed.' },
      { name: 'tenant', label: 'Approved tenant scope', type: 'select', required: true, defaultValue: '',
        options: [{ value: '', label: 'Select an approved tenant' }, { value: 'north', label: 'North' }, { value: 'south', label: 'South' }, { value: 'both', label: 'Both tenants' }],
        help: 'Users missing from one tenant are reported while the other tenant continues.' },
      { name: 'action', label: 'Access change', type: 'select', required: true, defaultValue: 'grant',
        options: [{ value: 'grant', label: 'Grant membership' }, { value: 'remove', label: 'Remove membership' }],
        help: 'Removal is explicit and applies only to the selected first Sales User Group.' }
    ]
  }
]);

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
