/**
 * The built-in image generation and visual review plugin for Web/Desktop.
 * This TypeScript entry owns the Loader protocol and the statically
 * discoverable configuration schema.
 *
 * @module @deepseek-ai/dsh-image-iterate-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as applyPlugin } from './plugin.ts'

export type { ImageCapability, ImageCapabilityRegistry } from './capability.ts'

/** Stable Cordis plugin name. */
export const name = 'image-iterate-plugin'

/** Services used by the image tool implementation. */
export const inject = ['tools', 'attachments', 'credentials', 'llm', 'userQuestions']

/** Configuration for automatic provider-owned image capability selection and optional advanced overrides. */
export interface Config {
  /** Optional advanced override endpoint for `POST /images/generations`; empty uses the current provider capability. */
  imageBaseUrl: string
  /** Optional advanced override image model. */
  imageModel: string
  /** Optional environment variable or DSH credential reference for the image override. */
  imageCredential: string
  /** Optional advanced override endpoint for `POST /chat/completions`; empty uses the current provider capability. */
  reviewBaseUrl: string
  /** Optional advanced override vision model. */
  reviewModel: string
  /** Optional environment variable or DSH credential reference for the review override. */
  reviewCredential: string
  /** Maximum number of paid image generations for one tool call. */
  maxIterations: number
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Default image size passed to the image provider. */
  defaultSize: string
  /** Default image quality passed to the image provider. */
  defaultQuality: string
  /** Attachment format used for generated images. */
  outputFormat: string
}

/** Validate and default the plugin configuration before the Host implementation runs. */
export const Config: z<Config> = z.object({
  imageBaseUrl: z.string().default(''),
  imageModel: z.string().default(''),
  imageCredential: z.string().default(''),
  reviewBaseUrl: z.string().default(''),
  reviewModel: z.string().default(''),
  reviewCredential: z.string().default(''),
  maxIterations: z.number().default(2),
  timeoutMs: z.number().default(120000),
  defaultSize: z.string().default('1024x1024'),
  defaultQuality: z.string().default('medium'),
  outputFormat: z.string().default('png'),
})

/**
 * Register the image generation and visual review tool.
 * @param ctx - Cordis context carrying the injected tool, attachment, and credential services.
 * @param config - validated image generation and visual review configuration.
 */
export function apply(ctx: Context, config: Config): void {
  applyPlugin(ctx, config)
}
