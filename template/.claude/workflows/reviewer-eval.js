export const meta = {
  name: 'reviewer-eval',
  description: 'Run the council over prepared eval cases and return its findings for each, to be graded separately.',
  whenToUse: 'Called by the reviewer-eval skill, with plans from eval.mjs prepare.',
  phases: [{ title: 'Review cases', detail: 'One full council round per case' }],
}

// args: { plans: [...], roundScript: 'absolute path to council-round.js' }
phase('Review cases')
const outcomes = []
// One case at a time keeps agent counts within each round's cap and makes a run easy to stop.
for (const plan of args.plans) {
  log(`Reviewing ${plan.key}`)
  try {
    const result = await workflow({ scriptPath: args.roundScript }, plan)
    outcomes.push([plan.key, result])
  } catch (error) {
    log(`${plan.key} failed: ${error.message}`)
    outcomes.push([plan.key, { findings: [], seats: [], missing: ['workflow'], refuted: 0 }])
  }
}
return Object.fromEntries(outcomes)
