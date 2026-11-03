import * as THREE from 'three/webgpu'

/**
 * Leaf textures: a list of { url | texture, weight, name }.
 *
 *   url      image to load (PNG / WebP with alpha, stem at the bottom centre)
 *   texture  an already loaded THREE.Texture, instead of url
 *   weight   how often it appears, relative to the others (see textureVariants.js)
 *   name     only for messages
 *
 * The defaults are five conifer sprigs bundled with the library, cut from a
 * reference photo. Their URLs resolve next to this module, so they work from
 * the package as installed.
 */
export const DEFAULT_LEAF_TEXTURES = [
    { name: 'variant1', weight: 30, url: new URL('../textures/leaf_variant_1.webp', import.meta.url).href }, // dark green, dense
    { name: 'variant2', weight: 25, url: new URL('../textures/leaf_variant_2.webp', import.meta.url).href }, // olive green, thin and sparse
    { name: 'variant3', weight: 20, url: new URL('../textures/leaf_variant_3.webp', import.meta.url).href }, // blue green, compact
    { name: 'variant4', weight: 15, url: new URL('../textures/leaf_variant_4.webp', import.meta.url).href }, // green and yellow, dry
    { name: 'variant5', weight: 10, url: new URL('../textures/leaf_variant_5.webp', import.meta.url).href } // grey green, cold and aged
]

/**
 * Loads all of them once. They are shared by the single leaf material.
 */
export async function loadLeafTextures(list)
{
    if(!Array.isArray(list) || list.length === 0)
        throw new Error('textures debe ser una lista con al menos una textura de hoja.')

    const loader = new THREE.TextureLoader()

    return Promise.all(list.map(async (entry, index) =>
    {
        const item = typeof entry === 'string' ? { url: entry } : entry
        if(item.texture) return item.texture

        try
        {
            const texture = await loader.loadAsync(item.url)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.name = item.name ?? `leaf${index + 1}`
            return texture
        }
        catch(error)
        {
            throw new Error(`No se ha podido cargar la textura de hoja "${item.url}".`)
        }
    }))
}
