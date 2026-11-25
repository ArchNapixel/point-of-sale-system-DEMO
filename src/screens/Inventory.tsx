import { useState } from 'react'
import Ingredients from './Ingredients'
import Recipes from './Recipes'
import Stock from './Stock'
import Purchasing from './Purchasing'
import Counts from './Counts'
import Costs from './Costs'

/** Inventory tab: ingredients and recipes today; stock, waste, purchasing and counts join in 3C to 3E. */
export default function Inventory() {
  const [part, setPart] = useState<'ingredients' | 'recipes' | 'stock' | 'purchasing' | 'counts' | 'costs'>('ingredients')
  return (
    <>
      <div className="seg">
        <button aria-pressed={part === 'ingredients'} onClick={() => setPart('ingredients')}>Ingredients</button>
        <button aria-pressed={part === 'recipes'} onClick={() => setPart('recipes')}>Recipes</button>
        <button aria-pressed={part === 'stock'} onClick={() => setPart('stock')}>Stock</button>
        <button aria-pressed={part === 'purchasing'} onClick={() => setPart('purchasing')}>Purchasing</button>
        <button aria-pressed={part === 'counts'} onClick={() => setPart('counts')}>Count</button>
        <button aria-pressed={part === 'costs'} onClick={() => setPart('costs')}>Cost and margin</button>
      </div>
      {part === 'ingredients' ? <Ingredients /> : part === 'recipes' ? <Recipes /> : part === 'stock' ? <Stock /> : part === 'purchasing' ? <Purchasing /> : part === 'counts' ? <Counts /> : <Costs />}
    </>
  )
}
