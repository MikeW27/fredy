/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildImmoscoutProvider } from '../services/immoscout/mobileApi.js';
import { convertAtWebToMobile } from '../services/immoscout/immoscout-web-translator.js';

const { metaInformation, config, createConfig } = buildImmoscoutProvider({
  id: 'immoscoutCh2',
  name: 'Immoscout Schweiz 2',
  baseUrl: 'https://www.immoscout24.ch/',
  countries: ['ch'],
  toMobileSearchUrl: convertAtWebToMobile,
});

export { metaInformation, config, createConfig };
