/** Provider-scoped model metadata from trusted bundled catalogs. */
import { catalogModels } from './catalog.ts'
import type { PiAiModality } from './catalog.ts'

export type ModelMetadataSource = 'pi-ai-catalog'
export interface ModelMetadata {
  readonly source: ModelMetadataSource
  readonly canonicalId: string
  readonly input?: readonly PiAiModality[]
  readonly contextWindow?: number
  readonly maxTokens?: number
}

/**
 * Resolve metadata only within the exact provider route. Normalization handles
 * benign case/separator differences and documented version suffixes; it never
 * joins an id from a different provider.
 */
export function resolveModelMetadata(provider: string, modelId: string): ModelMetadata | undefined {
  const route = normalize(provider)
  const id = normalizeModel(modelId)
  const catalog = catalogModels(route)
  for (const model of catalog.values()) {
    if (normalizeModel(model.id) !== id) continue
    return {
      source: 'pi-ai-catalog', canonicalId: model.id, input: [...model.input],
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    }
  }
  return undefined
}

function normalize(value: string): string { return value.trim().toLowerCase() }
function normalizeModel(value: string): string { return normalize(value).replaceAll('_', '-') }
