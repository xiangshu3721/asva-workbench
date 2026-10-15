import type { Product } from './domain'

function isOrientalLeadership(product: Product) {
  return product.name === '东方领导力' || product.id === 'P-004'
}

/** Keep catalog order intact while pinning 东方领导力 to the end of selectors. */
export function sortProductsForSelection(products: Product[]) {
  return [...products].sort((left, right) => Number(isOrientalLeadership(left)) - Number(isOrientalLeadership(right)))
}
