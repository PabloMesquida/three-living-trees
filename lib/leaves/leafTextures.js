import * as THREE from 'three/webgpu'

/**
 * Leaf textures, supplied by the app like the tree's GLB: the library ships
 * none. A list of 1 to MAX_LEAF_TEXTURES entries { url | texture, weight, name }:
 *
 *   url      image to load: PNG or WebP with alpha, the stem at the bottom
 *            centre, any proportion: the leaf is as tall as params.leafSize
 *            and as wide as the image's width / height says
 *   texture  an already loaded THREE.Texture, instead of url. It is used as
 *            it is: set its colorSpace to THREE.SRGBColorSpace yourself, and
 *            its anisotropy to renderer.getMaxAnisotropy() for leaves seen
 *            edge-on. Its proportion is read from its image, so it must be
 *            loaded already
 *   weight   how often it appears, relative to the others (see textureVariants.js)
 *   name     only for messages
 *
 * No list, or an empty one, draws the leaves with the built-in leaf shape
 * instead (see LeafRenderer.js).
 */
export const MAX_LEAF_TEXTURES = 5

export function checkLeafTextures(list)
{
    if(list === undefined || list === null) return []
    if(!Array.isArray(list))
        throw new Error('textures debe ser una lista de texturas de hoja: [{ url, weight }].')
    if(list.length > MAX_LEAF_TEXTURES)
        throw new Error(`Se pasaron ${list.length} texturas de hoja; el máximo es ${MAX_LEAF_TEXTURES}.`)

    list.forEach((entry, index) =>
    {
        const item = typeof entry === 'string' ? { url: entry } : entry
        if(item === null || typeof item !== 'object' || (!item.url && !item.texture?.isTexture))
            throw new Error(`La textura de hoja ${index + 1} necesita \`url\` o \`texture\` (un THREE.Texture ya cargado).`)
    })

    return list
}

/**
 * Loads the ones given by url, once. They are shared by the single leaf material.
 * With a renderer, they get its highest anisotropic filtering: leaves seen
 * almost edge-on (on the ground, from low down) keep their detail instead of
 * fading into a blurred mipmap.
 */
export async function loadLeafTextures(list, renderer = null)
{
    const loader = new THREE.TextureLoader()

    return Promise.all(checkLeafTextures(list).map(async (entry, index) =>
    {
        const item = typeof entry === 'string' ? { url: entry } : entry
        if(item.texture) return item.texture

        try
        {
            const texture = await loader.loadAsync(item.url)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.name = item.name ?? `leaf${index + 1}`
            if(renderer !== null) texture.anisotropy = renderer.getMaxAnisotropy()
            return texture
        }
        catch(error)
        {
            throw new Error(`No se ha podido cargar la textura de hoja "${item.url}".`)
        }
    }))
}

/**
 * [width, height] of a leaf texture, read from its image: an <img>, an
 * ImageBitmap, a canvas, a video, or the { width, height } of a data or
 * compressed texture.
 */
export function leafTextureSize(texture, index)
{
    const image = texture.image
    const width = image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0
    const height = image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0

    if(!(width > 0 && height > 0))
        throw new Error(`La textura de hoja ${index + 1} no tiene imagen todavía: su proporción sale de la imagen, así que tiene que estar cargada (por ejemplo con TextureLoader.loadAsync).`)

    return [width, height]
}

/** Width / height of a leaf texture. */
export function leafTextureAspect(texture, index)
{
    const [width, height] = leafTextureSize(texture, index)
    return width / height
}
