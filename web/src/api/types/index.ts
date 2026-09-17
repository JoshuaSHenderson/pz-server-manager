// The shapes the manager actually returns.
//
// Hand-written rather than generated, because the API is JavaScript and generating from it would
// mean trusting inference over a codebase that predates the types. Where a field is optional here
// it is because the server genuinely omits it, not because nobody checked.
//
// Split by subject rather than kept as one file, so the mod types — which are most of them, and
// where the manager's real complexity lives — are not something you scroll past to reach a
// schedule.

export * from './server'
export * from './mods'
export * from './config'
