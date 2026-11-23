/**
 * The built-in image generation and visual review plugin for Web/Desktop.
 * This TypeScript entry owns the Loader protocol and the statically
 * discoverable configuration schema.
 *
 * @module @deepseek-ai/dsh-image-iterate-plugin
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as applyPlugin } from './plugin.ts'

export type { ImageCapability, ImageCapabilityRegistry, ImageReviewCapability } from './capability.ts'
export { ImageCapabilityRegistryService, provideImageCapabilityRegistry } from './capability.ts'

/** Stable Cordis plugin name. */
export const name = 'image-iterate-plugin'

/** Services used by the image tool implementation. */
export const inject = ['tools', 'attachments', 'credentials', 'llm', 'userQuestions', 'systemPrompt']

/** Configuration for automatic provider-owned image capability selection and optional advanced overrides. */
export interface Config {
  /** Optional advanced override endpoint for `POST /images/generations`; empty uses the current provider capability. */
  imageBaseUrl: Volatile<string>
  /** Optional advanced override image model. */
  imageModel: Volatile<string>
  /** Optional environment variable or DSH credential reference for the image override. */
  imageCredential: Volatile<string>
  /** Optional advanced override endpoint for `POST /chat/completions`; empty uses the current provider capability. */
  reviewBaseUrl: Volatile<string>
  /** Optional advanced override vision model. */
  reviewModel: Volatile<string>
  /** Optional environment variable or DSH credential reference for the review override. */
  reviewCredential: Volatile<string>
  /** Maximum number of paid image generations for one tool call. */
  maxIterations: Volatile<number>
  /** Per-request timeout in milliseconds. */
  timeoutMs: Volatile<number>
  /** Default image size passed to the image provider. */
  defaultSize: Volatile<string>
  /** Default image quality passed to the image provider. */
  defaultQuality: Volatile<string>
  /** Attachment format used for generated images. */
  outputFormat: Volatile<string>
}

/** Validate and default the plugin configuration before the Host implementation runs. */
export const Config = z.object({
  imageBaseUrl: z.string().default('').volatile(),
  imageModel: z.string().default('').volatile(),
  imageCredential: z.string().default('').volatile(),
  reviewBaseUrl: z.string().default('').volatile(),
  reviewModel: z.string().default('').volatile(),
  reviewCredential: z.string().default('').volatile(),
  maxIterations: z.number().default(2).volatile(),
  timeoutMs: z.number().default(120000).volatile(),
  defaultSize: z.string().default('1024x1024').volatile(),
  defaultQuality: z.string().default('medium').volatile(),
  outputFormat: z.string().default('png').volatile(),
})

/**
 * Register the image generation and visual review tool.
 * @param ctx - Cordis context carrying the injected tool, attachment, and credential services.
 * @param config - validated image generation and visual review configuration.
 */
export function apply(ctx: Context, config: Config): void {
  applyPlugin(ctx, config)
}
