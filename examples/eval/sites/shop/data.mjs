// Seeded synthetic shop catalog.
import { rng, pick } from '../../lib/common.mjs'

export const BRANDS = ['Aldermoor', 'Brightwell', 'Corvane', 'Dunmere', 'Estwick']
const TYPES = [['Jacket', ['S', 'M', 'L', 'XL']], ['Backpack', null], ['Sneaker', ['40', '41', '42', '43', '44']], ['Desk Lamp', null], ['Kettle', null], ['Headphones', null], ['Hoodie', ['S', 'M', 'L']]]
const ADJ = ['Trail', 'Urban', 'Summit', 'Coastal', 'Metro', 'Polar', 'Studio', 'Harbor', 'Canyon', 'Aurora', 'Field', 'Nimbus']
const COLORS = ['Black', 'Navy', 'Olive', 'Sand', 'Rust', 'Grey', 'White', 'Teal']
export const CITIES = ['Springfield', 'Riverton', 'Lakeside', 'Fairview', 'Greenville', 'Brookfield', 'Oakridge', 'Millbrook', 'Westfield', 'Kingsport', 'Ashford', 'Clearwater']
export const COUPONS = { atlas: 'AUTUMN15', birch: 'WELCOME15' }
export const ACCOUNTS = { atlas: { email: 'riley@example.test', password: 'Harbor!2026', otp: '482913', points: 1840 }, birch: { email: 'sam@example.test', password: 'Meadow#77', otp: '705126', points: 615 } }

const cache = new Map()
export function shopData(seed) {
  if (cache.has(seed)) return cache.get(seed)
  const r = rng('shop:' + seed), names = new Set(), products = []
  while (products.length < 60) {
    const [type, sizes] = pick(r, TYPES), brand = BRANDS[products.length % BRANDS.length], name = `${brand} ${pick(r, ADJ)} ${type}`
    if (names.has(name)) continue
    names.add(name)
    const colors = [...new Set([pick(r, COLORS), pick(r, COLORS), pick(r, COLORS), pick(r, COLORS)])].slice(0, 3)
    // Prices are unique so "cheapest" questions have one answer.
    products.push({ id: products.length + 1, name, brand, type, sizes, colors, price: 1999 + products.length * 137 + Math.floor(r() * 90) * 10 + (products.length % 7) * 1000 })
  }
  const data = { products }
  cache.set(seed, data)
  return data
}
export const money = cents => `$${(cents / 100).toFixed(2)}`
