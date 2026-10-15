import { describe, expect, it } from 'vitest'
import type { Product } from './domain'
import { sortProductsForSelection } from './product-order'

const product = (id: string, name: string) => ({ id, name } as Product)

describe('product selector order', () => {
  it('moves 东方领导力 to the end and keeps every other product in source order', () => {
    const input = [product('P-004', '东方领导力'), product('P-005', '觉塑 I 模：自我诞生'), product('P-006', '花道')]

    expect(sortProductsForSelection(input).map((item) => item.name)).toEqual(['觉塑 I 模：自我诞生', '花道', '东方领导力'])
    expect(input.map((item) => item.name)).toEqual(['东方领导力', '觉塑 I 模：自我诞生', '花道'])
  })

  it('also recognizes 东方领导力 by name when the id is not P-004', () => {
    const input = [product('custom-id', '东方领导力'), product('P-005', '觉塑 I 模：自我诞生')]

    expect(sortProductsForSelection(input).map((item) => item.name)).toEqual(['觉塑 I 模：自我诞生', '东方领导力'])
  })
})
