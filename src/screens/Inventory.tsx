import { useState } from 'react'
import Ingredients from './Ingredients'
import Recipes from './Recipes'

/** Inventory tab: ingredients and recipes today; stock, waste, purchasing and counts join in 3C to 3E. */
export default function Inventory() {
  const [part, setPart] = useState<'ingredients' | 'recipes'>('ingredients')
  return (
    <>
      <div className="seg">
        <button aria-pressed={part === 'ingredients'} onClick={() => setPart('ingredients')}>Ingredients</button>
        <button aria-pressed={part === 'recipes'} onClick={() => setPart('recipes')}>Recipes</button>
      </div>
      {part === 'ingredients' ? <Ingredients /> : <Recipes />}
    </>
  )
}
