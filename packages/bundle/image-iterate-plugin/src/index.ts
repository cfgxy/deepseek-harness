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

/** Stable Cordis plugin name. */
export const name = 'image-iterate-plugin'

/** Services used by the image tool implementation. */
export const inject = ['tools', 'attachments', 'credentials']

/** Configuration for image generation and independent visual review requests. */
export interface Config {
  /** OpenAI-compatible base URL for `POST /images/generations`. */
  imageBaseUrl: string
  /** Image model name accepted by the configured image provider. */
  imageModel: string
  /** Environment variable or DSH credential reference for image requests. */
  imageCredential: string
  /** OpenAI-compatible base URL for `POST /chat/completions`. */
  reviewBaseUrl: string
  /** Vision model name accepted by the configured review provider. */
  reviewModel: string
  /** Environment variable or DSH credential reference for review requests. */
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
