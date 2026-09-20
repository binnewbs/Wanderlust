/**
 * Curated list of Dukascopy instruments for the New Session asset selector.
 * Ids are Dukascopy datafeed codes (see the dukascopy-downloader project's
 * symbol list); only FX + metals are guaranteed to have pre-computed candle
 * files on the public feed. Keep in sync with the data source; mostly static
 * so the renderer never has to import any main-process-only package.
 */
export interface Asset {
  /** Dukascopy instrument id, lowercase (e.g. 'eurusd'). */
  id: string
  /** Human-readable pair/index name (e.g. 'EUR/USD'). */
  label: string
  /** Asset category shown in the dropdown's option groups. */
  category: string
}

export const ASSETS: Asset[] = [
  {
    id: 'eurusd',
    label: 'EUR/USD',
    category: 'FX'
  },
  {
    id: 'gbpusd',
    label: 'GBP/USD',
    category: 'FX'
  },
  {
    id: 'usdjpy',
    label: 'USD/JPY',
    category: 'FX'
  },
  {
    id: 'usdcad',
    label: 'USD/CAD',
    category: 'FX'
  },
  {
    id: 'audusd',
    label: 'AUD/USD',
    category: 'FX'
  },
  {
    id: 'nzdusd',
    label: 'NZD/USD',
    category: 'FX'
  },
  {
    id: 'usdchf',
    label: 'USD/CHF',
    category: 'FX'
  },
  {
    id: 'eurjpy',
    label: 'EUR/JPY',
    category: 'FX Crosses'
  },
  {
    id: 'eurgbp',
    label: 'EUR/GBP',
    category: 'FX Crosses'
  },
  {
    id: 'eurchf',
    label: 'EUR/CHF',
    category: 'FX Crosses'
  },
  {
    id: 'gbpjpy',
    label: 'GBP/JPY',
    category: 'FX Crosses'
  },
  {
    id: 'gbpchf',
    label: 'GBP/CHF',
    category: 'FX Crosses'
  },
  {
    id: 'audjpy',
    label: 'AUD/JPY',
    category: 'FX Crosses'
  },
  {
    id: 'euraud',
    label: 'EUR/AUD',
    category: 'FX Crosses'
  },
  {
    id: 'eurcad',
    label: 'EUR/CAD',
    category: 'FX Crosses'
  },
  {
    id: 'eurnzd',
    label: 'EUR/NZD',
    category: 'FX Crosses'
  },
  {
    id: 'gbpaud',
    label: 'GBP/AUD',
    category: 'FX Crosses'
  },
  {
    id: 'nzdjpy',
    label: 'NZD/JPY',
    category: 'FX Crosses'
  },
  {
    id: 'cadchf',
    label: 'CAD/CHF',
    category: 'FX Crosses'
  },
  {
    id: 'usdhkd',
    label: 'USD/HKD',
    category: 'FX Crosses'
  },
  {
    id: 'usdsgd',
    label: 'USD/SGD',
    category: 'FX Crosses'
  },
  {
    id: 'xauusd',
    label: 'XAU/USD',
    category: 'Metals'
  },
  {
    id: 'xagusd',
    label: 'XAG/USD',
    category: 'Metals'
  },
  {
    id: 'xaujpy',
    label: 'XAU/JPY',
    category: 'Metals'
  },
  {
    id: 'xaghkd',
    label: 'XAG/HKD',
    category: 'Metals'
  },
  {
    id: 'btcusd',
    label: 'BTC/USD',
    category: 'Crypto'
  },
  {
    id: 'ethusd',
    label: 'ETH/USD',
    category: 'Crypto'
  },
  {
    id: 'btceur',
    label: 'BTC/EUR',
    category: 'Crypto'
  },
  {
    id: 'etheur',
    label: 'ETH/EUR',
    category: 'Crypto'
  },
  {
    id: 'dshusd',
    label: 'DSH/USD',
    category: 'Crypto'
  },
  {
    id: 'ltcusd',
    label: 'LTC/USD',
    category: 'Crypto'
  },
  {
    id: 'adausd',
    label: 'ADA/USD',
    category: 'Crypto'
  },
  {
    id: 'usa500idxusd',
    label: 'USA500.IDX/USD',
    category: 'Indices'
  },
  {
    id: 'usatechidxusd',
    label: 'US 100 Tech',
    category: 'Indices'
  },
  {
    id: 'tecdaxedeeur',
    label: 'TECDAXE.DE/EUR',
    category: 'Indices'
  },
  {
    id: 'spxgbgbx',
    label: 'SPX.GB/GBX',
    category: 'Indices'
  },
  {
    id: 'cndxgbusd',
    label: 'CNDX.GB/USD',
    category: 'Indices'
  },
  {
    id: 'caciususd',
    label: 'CACI.US/USD',
    category: 'Indices'
  }
]

export const ASSET_BY_ID: Record<string, Asset> = Object.fromEntries(ASSETS.map((a) => [a.id, a]))
