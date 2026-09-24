import type { OhMyOpenCodeConfig } from "../../config"
import { createAvailableCategories } from "../../plugin/available-categories"
import { createJevIntentRouting, type JevIntentRouting } from "./intent-routing"
import { createJevIntentRoutingVocabulary } from "./intent-routing-vocabulary"

export function createPluginJevIntentRouting(
  pluginConfig: OhMyOpenCodeConfig | undefined,
): JevIntentRouting {
  const categories = pluginConfig === undefined
    ? []
    : createAvailableCategories(pluginConfig)
  return createJevIntentRouting({
    jevConfig: pluginConfig?.jev,
    vocab: createJevIntentRoutingVocabulary(categories),
  })
}
