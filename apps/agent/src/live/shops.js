// Start list for the live web mode: real Shopify stores that answered the public storefront search,
// product JSON and a product page with schema.org JSON-LD in US dollars, without login or bot wall (tested 21.11.2026).
// Names only – no store logos. The user can switch stores off or add another store in the panel.
export const DEFAULT_LIVE_SHOPS = Object.freeze([
  { host: 'www.allbirds.com', name: 'Allbirds', categories: ['running_shoes', 'clothing'], currency: 'USD' },
  { host: 'www.xeroshoes.com', name: 'Xero Shoes', categories: ['running_shoes'], currency: 'USD' },
  { host: 'www.skullcandy.com', name: 'Skullcandy', categories: ['headphones'], currency: 'USD' },
  { host: 'www.thehouseofmarley.com', name: 'House of Marley', categories: ['headphones'], currency: 'USD' },
  { host: 'www.deathwishcoffee.com', name: 'Death Wish Coffee', categories: ['coffee'], currency: 'USD' },
  { host: 'www.lacolombe.com', name: 'La Colombe', categories: ['coffee'], currency: 'USD' },
  { host: 'www.intelligentsia.com', name: 'Intelligentsia', categories: ['coffee'], currency: 'USD' },
  { host: 'counterculturecoffee.com', name: 'Counter Culture Coffee', categories: ['coffee'], currency: 'USD' },
  { host: 'www.tentree.com', name: 'tentree', categories: ['clothing'], currency: 'USD' },
  { host: 'www.cotopaxi.com', name: 'Cotopaxi', categories: ['clothing'], currency: 'USD' },
  { host: 'www.outdoorvoices.com', name: 'Outdoor Voices', categories: ['clothing'], currency: 'USD' },
  { host: 'www.taylorstitch.com', name: 'Taylor Stitch', categories: ['clothing'], currency: 'USD' },
].map((s) => Object.freeze({ ...s, categories: Object.freeze([...s.categories]) })));

/** SHOPZ_LIVE_SHOPS="www.a.com:Name A,www.b.com" overrides the start list (categories unknown → searched for every request). */
export function shopsFromEnv(value = process.env.SHOPZ_LIVE_SHOPS) {
  if (!value || !String(value).trim()) return DEFAULT_LIVE_SHOPS;
  return String(value).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [host, ...name] = x.split(':');
    const known = DEFAULT_LIVE_SHOPS.find((s) => s.host === host.trim().toLowerCase());
    return known || { host: host.trim().toLowerCase(), name: name.join(':').trim() || host.trim(), categories: [], currency: 'USD' };
  });
}
