/** Provider-scoped model metadata from trusted bundled catalogs. */
import { catalogModels } from './catalog.ts'
import type { PiAiModality } from './catalog.ts'

export type ModelMetadataSource = 'pi-ai-catalog' | 'panuoyun-catalog'
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
  if (route === 'panuoyun' && terraAlias(id)) {
    return { source: 'panuoyun-catalog', canonicalId: 'gpt-5.6-terra', input: ['text', 'image'] }
  }
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
/** `-latest` and date/build suffixes are aliases only for the dedicated Pa诺云 Terra record. */
function terraAlias(value: string): boolean {
  return /^gpt-5\.6-terra(?:-(?:latest|\d{4}(?:-\d{2}){0,2}|v\d+))?$/.test(value)
}
