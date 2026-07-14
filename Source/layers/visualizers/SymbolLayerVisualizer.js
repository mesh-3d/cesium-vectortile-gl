import { VectorTileFeature } from '@mapbox/vector-tile'
import { ILayerVisualizer } from './ILayerVisualizer'
import { SymbolRenderLayer } from '../SymbolRenderLayer'
import { warnOnce } from 'maplibre-gl/src/util/util'

export class SymbolFeature {
  constructor() {
    this.featureId = 0
    this.textColor = Cesium.Color.BLACK.clone()
    this.textSize = 12
    this.coordinates = []
  }
}

/**@type {Cesium.Cartesian3} */
let scratchDirectionToEye = null
/**@type {Cesium.Cartesian3} */
let scratchSurfaceNormal = null

/** 淡入淡出每帧向目标透明度的插值系数，约 0.10 时 ~10帧完成过渡，越小越慢 */
const FADE_SPEED = 0.1

export class SymbolLayerVisualizer extends ILayerVisualizer {
  constructor(layers, tile) {
    if (scratchDirectionToEye === null) {
      scratchDirectionToEye = new Cesium.Cartesian3()
      scratchSurfaceNormal = new Cesium.Cartesian3()
    }

    super(layers, tile)

    /**@type {Cesium.Label[]} */
    this.labels = []
    this.primitive = null
    this.dotCutOff = 0.0035
  }

  /**
   * 对符号进行地平线剔除
   * @param {Cesium.Cartesian3} positionWC
   * @param {Cesium.Cartesian3} cameraPositionWC
   */
  isOccluded(cameraPositionWC, positionWC) {
    /*
        如下图，o为符号锚点，up为椭球面过锚点o的法线，tangent为过锚点o的切线，eye为相机位置。
        可见，当锚点在地平线以下时，eye方向与up方向夹角小于90°。
        up
        ^
        |
        o —— —— > tangent
         \
          \
           eye
        */
    const eyeDir = Cesium.Cartesian3.subtract(
      cameraPositionWC,
      positionWC,
      scratchDirectionToEye
    )
    Cesium.Cartesian3.normalize(eyeDir, eyeDir)
    const up = Cesium.Cartesian3.normalize(positionWC, scratchSurfaceNormal)
    return Cesium.Cartesian3.dot(eyeDir, up) < this.dotCutOff
  }

  /**
   * @param {VectorTileFeature[]} features
   * @param {SymbolRenderLayer} layer
   * @param {Cesium.frameState} frameState
   * @param {VectorTileset} tileset
   */
  addLayer(features, layer, frameState, tileset) {
    const style = layer.style
    const { tile, labels } = this
    const rectangle = tile.rectangle

    function addText(
      coord,
      text,
      font,
      textSize,
      textColor,
      outlineWidth,
      outlineColor,
      textOffset,
      textOrigin,
      properties
    ) {
      if (
        !Cesium.Rectangle.contains(
          rectangle,
          Cesium.Cartographic.fromDegrees(coord[0], coord[1])
        ) ||
        !text
      ) {
        return
      }
      const label = new Cesium.Label({
        position: Cesium.Cartesian3.fromDegrees(coord[0], coord[1]),
        text,
        font: textSize + 'px ' + font,
        fillColor: textColor,
        style: outlineWidth && Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: outlineWidth * textSize,
        outlineColor,
        //禁用深度测试
        disableDepthTestDistance: Infinity,
        pixelOffset: new Cesium.Cartesian2(
          textOffset[0] * textSize,
          textOffset[1] * textSize
        ),
        horizontalOrigin: textOrigin.horizontal,
        verticalOrigin: textOrigin.vertical
      })
      label._baseFillColor = label.fillColor.clone()
      label._baseOutlineColor = label.outlineColor.clone()
      label.vtAlpha = 0
      label.batchId = labels.length
      labels.push(label)
      layer.labels.push(label)
      layer.features.push({
        text,
        font,
        textSize,
        textColor,
        outlineWidth,
        outlineColor,
        textOffset,
        textOrigin,
        properties
      })
    }

    for (const sourceFeature of features) {
      const feature = sourceFeature.toGeoJSON(tile.x, tile.y, tile.z)
      if (!feature.geometry) continue
      const properties = sourceFeature.properties

      //读取图层样式属性
      const iconImage = style.layout.getDataValue(
        'icon-image',
        tile.z,
        sourceFeature
      )
      const textField = style.layout.getDataValue(
        'text-field',
        tile.z,
        sourceFeature
      )
      let text = textField
      if (typeof text === 'string') {
        text = style.layout.resolveTokens(properties, textField)
      } else if (text && text.sections) {
        for (const section of text.sections) {
          section.text = style.layout.resolveTokens(properties, section.text)
        }
        text = text.toString()
      }
      if (iconImage) {
        warnOnce('symbol图层：不支持图标')
        continue
      }
      if (!text) {
        continue
      }

      const textTransform = style.layout.getDataValue(
        'text-transform',
        tile.z,
        sourceFeature
      )
      if (textTransform === 'uppercase') {
        text = String(text).toUpperCase()
      } else if (textTransform === 'lowercase') {
        text = String(text).toLowerCase()
      }

      const maxWidth =
        style.layout.getDataValue('text-max-width', tile.z, sourceFeature) * 3
      const textRotationAlignment = style.layout.getDataValue(
        'text-rotation-alignment',
        tile.z,
        sourceFeature
      )
      const textPitchAlignment = style.layout.getDataValue(
        'text-pitch-alignment',
        tile.z,
        sourceFeature
      )
      if (text.length > maxWidth) {
        warnOnce('symbol图层： 不支持 text-max-width，无自动换行效果')
      }
      if (textRotationAlignment === 'map') {
        warnOnce('symbol图层：text-rotation-alignment 仅支持 viewport')
      }
      if (textPitchAlignment === 'map') {
        warnOnce('symbol图层：text-pitch-alignment 仅支持 viewport')
      }

      const font = style.layout.getDataValue('text-font', tile.z, sourceFeature)
      const textSize = style.layout.getDataValue(
        'text-size',
        tile.z,
        sourceFeature
      )
      const textAnchor = style.layout.getDataValue(
        'text-anchor',
        tile.z,
        sourceFeature
      )
      const textOrigin = getOrigin(textAnchor)
      const textOffset = style.layout.getDataValue(
        'text-offset',
        tile.z,
        sourceFeature
      )
      const textColor = style.convertColor(
        style.paint.getDataValue('text-color', tile.z, sourceFeature)
      )
      const outlineColor = style.convertColor(
        style.paint.getDataValue('text-halo-color', tile.z, sourceFeature)
      )
      const outlineWidth = style.paint.getDataValue(
        'text-halo-width',
        tile.z,
        sourceFeature
      )

      if (!textSize || !isFinite(textSize) || Number(textSize) <= 0) {
        continue
      }

      const geometryType = feature.geometry.type
      const coordinates = feature.geometry.coordinates
      if (geometryType == 'Point') {
        addText(
          coordinates,
          text,
          font,
          textSize,
          textColor,
          outlineWidth,
          outlineColor,
          textOffset,
          textOrigin,
          properties
        )
      } else if (geometryType == 'MultiPoint') {
        coordinates.forEach(coord => {
          addText(
            coord,
            text,
            font,
            textSize,
            textColor,
            outlineWidth,
            outlineColor,
            textOffset,
            textOrigin,
            properties
          )
        })
      } else {
        warnOnce('symbol图层：不支持符号沿线布局')
      }
    }

    this.layers.push(layer)
  }

  /**
   * 从 Web Worker 结果构建符号图层（placements 已由 Worker 算好）
   * @param {object} workerLayerData - { layerId, source, sourceLayer, styleLayer, placements }
   * @param {SymbolRenderLayer} layer
   * @param {Cesium.FrameState} frameState
   * @param {VectorTileset} tileset
   */
  addLayerFromWorkerResult(workerLayerData, layer, frameState, tileset) {
    const { placements } = workerLayerData
    const { labels } = this
    const rectangle = this.tile.rectangle

    for (const p of placements || []) {
      if (
        !Cesium.Rectangle.contains(
          rectangle,
          Cesium.Cartographic.fromDegrees(p.coord[0], p.coord[1])
        )
      ) {
        continue
      }
      const textColor = Cesium.Color.fromBytes(
        p.textColorBytes[0],
        p.textColorBytes[1],
        p.textColorBytes[2],
        p.textColorBytes[3]
      )
      const outlineColor = Cesium.Color.fromBytes(
        p.outlineColorBytes[0],
        p.outlineColorBytes[1],
        p.outlineColorBytes[2],
        p.outlineColorBytes[3]
      )
      const textOrigin = getOrigin(p.textAnchor)
      const label = new Cesium.Label({
        position: Cesium.Cartesian3.fromDegrees(p.coord[0], p.coord[1]),
        text: p.text,
        font: p.textSize + 'px ' + p.font,
        fillColor: textColor,
        style:
          p.outlineWidth > 0
            ? Cesium.LabelStyle.FILL_AND_OUTLINE
            : Cesium.LabelStyle.FILL,
        outlineWidth: p.outlineWidth * p.textSize,
        outlineColor,
        disableDepthTestDistance: Infinity,
        pixelOffset: new Cesium.Cartesian2(
          (p.textOffset[0] || 0) * p.textSize,
          (p.textOffset[1] || 0) * p.textSize
        ),
        horizontalOrigin: textOrigin.horizontal,
        verticalOrigin: textOrigin.vertical
      })
      label._baseFillColor = label.fillColor.clone()
      label._baseOutlineColor = label.outlineColor.clone()
      label.vtAlpha = 0
      label.batchId = labels.length
      labels.push(label)
      layer.labels.push(label)
    }

    this.layers.push(layer)
  }

  createPrimitive() {
    //所有图层的文字共用一个LabelCollection
    //注意：这样文字就没有了“图层”的特征了，渲染顺序可能和样式配置的不一致
    //优化：参考 maplibre-gl 的符号系统实现，但工作量巨大，如有需求建议使用商业版（Mesh-3D矢量地图引擎）

    const primitive = new Cesium.LabelCollection()
    for (let i = 0; i < this.labels.length; i++) {
      this.labels[i] = primitive.add(this.labels[i])
    }

    /**@type {SymbolRenderLayer[]} */
    const layers = this.layers
    for (const layer of layers) {
      for (let i = 0; i < layer.labels.length; i++) {
        layer.labels[i] = this.labels[layer.labels[i].batchId]
      }
    }

    this.primitive = primitive
  }

  update(frameState, tileset) {
    if (this.state !== 'none') return

    if (!this.primitive && this.labels?.length) {
      this.createPrimitive()
    }

    //性能优化：这里应该进行自动避让处理

    if (this.primitive) {
      this.commandList.length = 0
      const preCommandList = frameState.commandList
      frameState.commandList = this.commandList
      this.primitive.update(frameState)
      frameState.commandList = preCommandList

      //解决Cesium特殊字符支持问题：生成的字形图纹理宽高为0的情况下，dimensions的height或者width为NaN，
      //导致drawCommand的boundingVolume.radius为NaN，
      //进而引发 View.createPotentiallyVisibleSet drawCommand按视锥分组失败的致命问题
      for (const label of this.labels) {
        const glyphs = label._glyphs
        if (glyphs) {
          let text = label.text,
            newGlyphs = [],
            newText = [],
            glyphsChanged = false
          for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex++) {
            const glyph = glyphs[glyphIndex]
            const dimensions = glyph.dimensions
            if (
              dimensions &&
              isFinite(dimensions.width) &&
              isFinite(dimensions.height)
            ) {
              newText.push(text[glyphIndex])
              newGlyphs.push(glyph)
            } else {
              glyphsChanged = true
            }
          }
          if (glyphsChanged) {
            label._glyphs = newGlyphs
            label.text = newText.join('')
          }
        }
      }

      if (this.state === 'none' && this.commandList.length > 0) {
        this.setState('done')
      }
      if (this.primitive._state === Cesium.PrimitiveState.FAILED) {
        this.setState('error')
      }
    } else if (this.state === 'none' && this.labels.length === 0) {
      this.setState('done')
    }
  }

  render(frameState, tileset) {
    if (this.state !== 'done') return

    const cameraPositionWC = frameState.camera.positionWC

    /**@type {SymbolRenderLayer[]} */
    const layers = this.layers
    for (const layer of layers) {
      for (let i = 0; i < layer.labels.length; i++) {
        const style = layer.style,
          zoom = tileset.zoom
        if (
          layer.visibility === 'none' ||
          zoom < style.minzoom ||
          zoom >= style.maxzoom
        ) {
          layer.labels[i].show = false
        } else {
          // 淡入淡出：根据 vtPlaceable 插值 vtAlpha，用 style 透明度控制，alpha 为 0 时才彻底隐藏
          const label = layer.labels[i]
          if (!label._baseFillColor) {
            label._baseFillColor = label.fillColor.clone()
            label._baseOutlineColor = label.outlineColor.clone()
            if (label.vtAlpha == null) label.vtAlpha = label.vtPlaceable ? 1 : 0
          }
          const targetAlpha = label.vtPlaceable ? 1 : 0
          label.vtAlpha = Cesium.Math.lerp(
            label.vtAlpha ?? 0,
            targetAlpha,
            FADE_SPEED
          )
          if (label.vtAlpha < 0.001) {
            label.vtAlpha = 0
            label.show = false
          } else {
            label.show = true
            label.fillColor = label._baseFillColor.withAlpha(
              label._baseFillColor.alpha * label.vtAlpha
            )
            label.outlineColor = label._baseOutlineColor.withAlpha(
              label._baseOutlineColor.alpha * label.vtAlpha
            )
          }
        }
      }
    }

    for (const label of this.labels) {
      if (label.show)
        label.show = !this.isOccluded(cameraPositionWC, label.position)
    }

    if (this.primitive) {
      this.commandList.length = 0
      const preCommandList = frameState.commandList
      frameState.commandList = this.commandList
      this.primitive.update(frameState)
      frameState.commandList = preCommandList
    }

    super.render(frameState)
  }

  destroy() {
    this.primitive = this.primitive && this.primitive.destroy()
    super.destroy()
  }

  isDestroyed() {
    return false
  }
}

function getOrigin(textAnchor) {
  let horizontal = Cesium.HorizontalOrigin.CENTER
  let vertical = Cesium.VerticalOrigin.CENTER

  switch (textAnchor) {
    case 'left':
      horizontal = Cesium.HorizontalOrigin.LEFT
      break
    case 'right':
      horizontal = Cesium.HorizontalOrigin.RIGHT
      break
    case 'top':
      vertical = Cesium.VerticalOrigin.TOP
      break
    case 'bottom':
      vertical = Cesium.VerticalOrigin.BOTTOM
      break
    case 'top-left':
      vertical = Cesium.VerticalOrigin.TOP
      horizontal = Cesium.HorizontalOrigin.LEFT
      break
    case 'top-right':
      vertical = Cesium.VerticalOrigin.TOP
      horizontal = Cesium.HorizontalOrigin.RIGHT
      break
    case 'bottom-left':
      vertical = Cesium.VerticalOrigin.BOTTOM
      horizontal = Cesium.HorizontalOrigin.LEFT
      break
    case 'bottom-right':
      vertical = Cesium.VerticalOrigin.BOTTOM
      horizontal = Cesium.HorizontalOrigin.RIGHT
      break
    case 'center':
    default:
      break
  }

  return {
    horizontal,
    vertical
  }
}
