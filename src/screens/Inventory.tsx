import { useState } from 'react'
import Ingredients from './Ingredients'
import Recipes from './Recipes'
import Stock from './Stock'

/** Inventory tab: ingredients and recipes today; stock, waste, purchasing and counts join in 3C to 3E. */
export default function Inventory() {
  const [part, setPart] = useState<'ingredients' | 'recipes' | 'stock'>('ingredients')
  return (
    <>
      <div className="seg">
        <button aria-pressed={part === 'ingredients'} onClick={() => setPart('ingredients')}>Ingredients</button>
        <button aria-pressed={part === 'recipes'} onClick={() => setPart('recipes')}>Recipes</button>
        <button aria-pressed={part === 'stock'} onClick={() => setPart('stock')}>Stock</button>
      </div>
      {part === 'ingredients' ? <Ingredients /> : part === 'recipes' ? <Recipes /> : <Stock />}
    </>
  )
}
