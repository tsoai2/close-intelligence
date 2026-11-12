// Editable process template library. These are illustrative starting points, not statements about any company.
// Row: [key, name, process, BD offset, prep hours, review hours, risk, dependencies, scope, account]
// Dependencies: "KEY" = finish-to-start, predecessor approved; "KEY~" = predecessor prepared is enough; "KEY^" = start-to-start.
const S = [
  ['PRE-01', 'Confirm close calendar, assignments and cutoffs', 'Close management', -3, 1, 0, 'low', '', 'group'],
  ['PRE-02', 'Prepare recurring journal entries', 'Accruals', -2, 2, 0.5, 'low', 'PRE-01', 'entity'],
  ['AP-01', 'AP cutoff and invoice processing deadline', 'Payables', 0, 3, 1, 'medium', 'PRE-01', 'entity', '2000'],
  ['AR-01', 'AR cutoff and cash application', 'Receivables', 0, 3, 1, 'medium', 'PRE-01', 'entity', '1100'],
  ['CASH-01', 'Retrieve bank statements', 'Cash', 1, 0.5, 0, 'low', '', 'entity', '1000'],
  ['CASH-02', 'Bank reconciliation — operating account', 'Cash', 1, 3, 1, 'high', 'CASH-01 AR-01~', 'entity', '1000'],
  ['PAY-01', 'Receive and post payroll register', 'Payroll', 1, 1.5, 0.5, 'medium', '', 'entity', '2200'],
  ['PAY-02', 'Payroll, bonus and commission accruals', 'Payroll', 2, 2, 1, 'medium', 'PAY-01', 'entity', '2200'],
  ['INV-01', 'Receive and validate period-end inventory report', 'Inventory / COGS', 1, 1, 0.5, 'high', '', 'entity', '1200'],
  ['INV-02', 'Inventory subledger to GL reconciliation', 'Inventory / COGS', 2, 3, 1.5, 'high', 'INV-01', 'entity', '1200'],
  ['AR-02', 'AR subledger to GL reconciliation', 'Receivables', 2, 2, 1, 'high', 'AR-01', 'entity', '1100'],
  ['AR-03', 'Allowance for doubtful accounts estimate', 'Receivables', 3, 2, 1, 'medium', 'AR-02', 'entity', '1150'],
  ['REV-01', 'Revenue cutoff testing', 'Revenue / cutoff', 2, 3, 1, 'high', 'AR-01', 'entity', '4000'],
  ['AP-02', 'AP subledger to GL reconciliation', 'Payables', 2, 2, 1, 'high', 'AP-01', 'entity', '2000'],
  ['AP-03', 'Accrued liabilities and uninvoiced receipts', 'Accruals', 2, 3, 1, 'high', 'AP-01', 'entity', '2100'],
  ['PREP-01', 'Prepaid expenses amortization', 'Accruals', 2, 1.5, 0.5, 'low', 'PRE-02~', 'entity', '1300'],
  ['FA-01', 'Fixed asset additions and disposals', 'Fixed assets', 2, 2, 1, 'medium', 'AP-01', 'entity', '1500'],
  ['FA-02', 'Depreciation run and reconciliation', 'Depreciation', 2, 1.5, 0.5, 'medium', 'FA-01', 'entity', '1550'],
  ['LEASE-01', 'Lease schedule and right-of-use asset update', 'Leases', 3, 1.5, 0.5, 'medium', '', 'entity', '1600'],
  ['DEBT-01', 'Debt, interest accrual and covenant calculation', 'Debt / interest / covenants', 3, 2, 1, 'high', 'CASH-02', 'entity', '2600'],
  ['TAX-01', 'Sales, use and value-added tax reconciliation', 'Tax', 3, 2, 1, 'medium', 'REV-01 AP-02', 'entity', '2300'],
  ['IC-01', 'Confirm intercompany balances with counterparties', 'Intercompany', 2, 2, 1, 'medium', 'AR-01 AP-01', 'entity', '1400'],
  ['FX-01', 'Load exchange rates and remeasure foreign balances', 'FX', 2, 1.5, 0.5, 'medium', '', 'entity'],
  ['IC-02', 'Intercompany reconciliation and matching', 'Intercompany', 3, 3, 1, 'high', 'IC-01 FX-01', 'group', '1400'],
  ['EQ-01', 'Equity rollforward', 'Equity', 4, 1, 0.5, 'low', '', 'group', '3000'],
  ['EST-01', 'Review significant estimates and judgments', 'Estimates', 4, 2, 1, 'high', 'AR-03~', 'group'],
  ['UNU-01', 'Review unusual and non-recurring transactions', 'Unusual transactions', 4, 1.5, 1, 'medium', 'AP-03~', 'group'],
  ['TB-01', 'Final trial balance extract', 'Financial reporting', 4, 1, 0.5, 'high', 'CASH-02 AR-03 AP-02 AP-03 PAY-02 INV-02 FA-02 PREP-01 LEASE-01 TAX-01 REV-01', 'entity'],
  ['FLUX-01', 'Flux and variance analysis', 'Financial reporting', 5, 3, 1.5, 'medium', 'TB-01', 'entity'],
  ['CONS-01', 'Consolidation and eliminations', 'Consolidation', 5, 3, 1.5, 'high', 'TB-01 IC-02 FX-01', 'group'],
  ['FS-01', 'Draft financial statements', 'Financial reporting', 5, 3, 1.5, 'high', 'CONS-01 EQ-01 EST-01', 'group'],
  ['TAX-02', 'Income tax provision estimate', 'Tax', 6, 2.5, 1, 'high', 'FS-01~', 'group', '8000'],
  ['MGMT-01', 'Management review package and commentary', 'Management review', 6, 2, 1, 'high', 'FS-01 FLUX-01 UNU-01', 'group'],
  ['CTRL-01', 'Close checklist and control evidence review', 'Management review', 6, 1.5, 1, 'medium', 'FS-01 TAX-02~', 'group'],
  ['LOCK-01', 'Period lock', 'Period lock', 6, 0.5, 0, 'medium', 'MGMT-01 CTRL-01', 'group'],
];
// Optional distributor / automotive-accessories additions.
const D = [
  ['REV-02', 'Retailer rebates and allowances accrual', 'Revenue / cutoff', 3, 4, 1.5, 'high', 'REV-01 RPT-02~', 'entity', '2150'],
  ['REV-03', 'Chargebacks and deductions review', 'Receivables', 3, 3, 1, 'medium', 'AR-02', 'entity', '4200'],
  ['REV-04', 'Returns reserve and warranty accrual', 'Revenue / cutoff', 3, 2, 1, 'medium', 'REV-01', 'entity', '2100'],
  ['AP-04', 'Freight and duties accrual', 'Payables', 3, 2, 1, 'medium', 'INV-01', 'entity', '5100'],
  ['INV-03', 'Goods in transit cutoff', 'Inventory / COGS', 2, 2, 1, 'high', 'INV-01', 'entity', '1260'],
  ['INV-04', 'Standard cost and purchase price variance analysis', 'Inventory / COGS', 3, 3, 1, 'medium', 'INV-02', 'entity', '5200'],
  ['INV-05', 'Inventory reserves (excess, obsolete, lower of cost or NRV)', 'Inventory / COGS', 3, 3, 1.5, 'high', 'INV-02', 'entity', '1250'],
  ['INV-06', 'COGS rollforward and margin review', 'Inventory / COGS', 4, 2, 1, 'high', 'INV-03 INV-04 INV-05 AP-04', 'entity', '5000'],
  ['INV-07', 'Third-party and consigned inventory confirmation', 'Inventory / COGS', 3, 1.5, 0.5, 'medium', 'INV-01', 'entity', '1200'],
  ['ROY-01', 'Royalties accrual', 'Accruals', 3, 2, 1, 'medium', 'REV-01', 'entity', '2100'],
  ['RPT-01', 'Sales by customer extract for flash reporting', 'Financial reporting', 1, 1, 0, 'low', 'AR-01~', 'entity'],
  ['RPT-02', 'Sales by customer extract for rebate accruals', 'Revenue / cutoff', 1, 1, 0, 'low', 'AR-01~', 'entity'],
];
const DIST_EXTRA_DEPS = { 'TB-01': 'INV-06 REV-02 REV-03 REV-04 ROY-01 INV-07', 'FLUX-01': 'RPT-01~', 'EST-01': 'INV-05~ REV-04~' };

export const EVIDENCE = {
  Cash: ['Bank statement', 'Bank reconciliation workpaper'], Receivables: ['Aged receivables report', 'Reconciliation workpaper'], Payables: ['Aged payables report', 'Reconciliation workpaper'],
  'Inventory / COGS': ['Inventory report', 'Reconciliation or calculation workpaper'], Payroll: ['Payroll register'], Accruals: ['Accrual calculation'], 'Revenue / cutoff': ['Supporting calculation'], 'Fixed assets': ['Fixed asset rollforward'], Depreciation: ['Depreciation report'],
  Leases: ['Lease schedule'], 'Debt / interest / covenants': ['Covenant calculation', 'Lender statement'], Tax: ['Tax workpaper'], Intercompany: ['Intercompany confirmation'], Consolidation: ['Consolidation workpaper'], 'Financial reporting': ['Report or extract'], 'Management review': ['Review package'],
};
export const STEPS = {
  default: ['Obtain source data for the period', 'Prepare workpaper and tie to the general ledger', 'Explain differences above threshold'],
  Cash: ['Download statements for every account', 'Match deposits and disbursements', 'List and age outstanding items', 'Tie adjusted bank balance to the general ledger'],
  'Inventory / COGS': ['Confirm receiving and shipping cutoff', 'Agree report totals to the subledger', 'Investigate variances above threshold', 'Document conclusions'],
  'Period lock': ['Confirm all sign-offs are recorded'], 'Close management': ['Confirm calendar and holidays', 'Confirm owners and backups'],
};
const PURPOSE = { Cash: 'Shows that recorded cash agrees with the bank and that reconciling items are valid and current.', 'Inventory / COGS': 'Supports the existence and valuation of inventory and the accuracy of cost of goods sold.', Receivables: 'Supports the existence and collectability of customer balances.', Payables: 'Supports the completeness of liabilities to suppliers.', Intercompany: 'Ensures balances between group entities agree so they eliminate on consolidation.', 'Financial reporting': 'Produces reliable statements and explanations for management.' };

function norm(rows, extraDeps = {}) {
  return rows.map(r => { const process = r[2]; const depStr = [r[7], extraDeps[r[0]]].filter(Boolean).join(' ');
    return { key: r[0], name: r[1], process, offset_bd: r[3], duration_min: Math.round(r[4] * 60), review_min: r[5] ? Math.round(r[5] * 60) : null, risk: r[6], scope: r[8], account: r[9] || null, recurrence: 'monthly', due_time: '17:00', priority: r[6] === 'high' ? 'high' : 'normal',
      deps: depStr.split(/\s+/).filter(Boolean).map(d => ({ key: d.replace(/[~^]$/, ''), type: d.endsWith('^') ? 'SS' : 'FS', gate: d.endsWith('~') ? 'prepared' : 'approved', lag_min: 0 })),
      evidence: r[5] ? EVIDENCE[process] || ['Supporting workpaper'] : [], steps: STEPS[process] || STEPS.default, purpose: PURPOSE[process] || `Supports the ${process.toLowerCase()} balances and disclosures for the period.`,
      description: `${r[1]} for the period.`, instructions: 'Follow the documented procedure for this task. Record anything unusual in the discussion so the reviewer and a future backup can follow it.', acceptance: r[5] ? 'Workpaper ties to the general ledger, differences above threshold are explained, and required evidence is attached.' : 'Output delivered and noted.', owner_role: r[5] ? 'preparer' : null }; });
}
export const LIBRARY = {
  standard: { name: 'Standard month-end close', description: 'Cash, receivables, revenue cutoff, payables, accruals, payroll, inventory, fixed assets, depreciation, leases, debt, tax, equity, intercompany, FX, consolidation, estimates, unusual transactions, reporting, management review and period lock.', tasks: () => norm(S) },
  distributor: { name: 'Distributor / automotive accessories close', description: 'The standard close plus retailer rebates and allowances, chargebacks, deductions, returns, warranty, freight and duties, goods in transit, inventory reserves, standard-cost and purchase-price variances, royalties and third-party inventory. Illustrative only.', tasks: () => norm([...S, ...D], DIST_EXTRA_DEPS) },
};
