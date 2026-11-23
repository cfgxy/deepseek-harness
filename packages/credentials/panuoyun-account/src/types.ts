/** Safe Pa诺云 Remote projections. They deliberately exclude JWTs and API keys. */
export interface PanuoyunGroup {
  readonly id: string
  readonly name: string
}

/** A model identifier returned after a selected key is verified. */
export interface PanuoyunModel {
  readonly id: string
}
