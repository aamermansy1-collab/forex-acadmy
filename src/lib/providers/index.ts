// سجل المزودات: ربط معرّف المزود بالمحول المناسب.

import type { ProviderId } from "../models";
import type { ProviderAdapter } from "./types";
import { kieProvider } from "./kie";
import { cometapiProvider } from "./cometapi";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieProvider,
  cometapi: cometapiProvider,
};

export type { ProviderAdapter, GenerateInput } from "./types";
export { ProviderError } from "./types";
