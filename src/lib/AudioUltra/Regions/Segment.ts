import { nanoid } from 'nanoid';
import { rgba, RgbaColorArray } from '../Common/Color';
import { Events } from '../Common/Events';
import { clamp, defaults, getCursorPositionX, getCursorTime, pixelsToTime } from '../Common/Utils';
import { CursorSymbol } from '../Cursor/Cursor';
import { Layer } from '../Visual/Layer';
import { Visualizer } from '../Visual/Visualizer';
import { Waveform } from '../Waveform';
import type { Regions } from './Regions';

export interface SegmentOptions {
  id?: string;
  start: number;
  end: number;
  color?: string|RgbaColorArray;
  selected?: boolean;
  updateable?: boolean;
  deleteable?: boolean;
  visible?: boolean;
}

export interface SegmentGlobalEvents {
  regionCreated: (region: Segment) => void;
  regionUpdated: (region: Segment) => void;
  regionSelected: (region: Segment, event: MouseEvent) => void;
  regionUpdatedEnd: (region: Segment) => void;
  regionRemoved: (region: Segment) => void;
}

interface SegmentEvents {
  update: (region: Segment) => void;
  updateEnd: (region: Segment) => void;
  mouseEnter: (region: Segment, event: MouseEvent) => void;
  mouseOver: (region: Segment, event: MouseEvent) => void;
  mouseLeave: (region: Segment, event: MouseEvent) => void;
  mouseDown: (region: Segment, event: MouseEvent) => void;
  mouseUp: (region: Segment, event: MouseEvent) => void;
  click: (region: Segment, event: MouseEvent) => void;
}

export class Segment extends Events<SegmentEvents> {
  id: string;
  start = 0;
  end = 0;
  color: RgbaColorArray = rgba('#ccc');
  handleColor: RgbaColorArray;
  selected = false;
  highlighted = false;
  updateable = true;
  deleteable = true;
  visible = true;
  private waveform: Waveform;
  private visualizer: Visualizer;
  private controller: Regions;
  private layer!: Layer;
  private handleWidth: number;
  private isDragging: boolean;
  private draggingStartPosition: null | { grabPosition: number, start: number, end: number };
  private isGrabbingEdge: { isRightEdge: boolean, isLeftEdge: boolean };

  constructor(
    options: SegmentOptions,
    waveform: Waveform,
    visualizer: Visualizer,
    controller: Regions,
  ) {
    super();

    if (options.start < 0) throw new Error('Segment start must be greater than 0');
    if (options.end < 0) throw new Error('Segment end must be greater than 0');

    this.id = options.id ?? nanoid(5);
    this.start = options.start;
    this.end = options.end;
    this.selected = !!options.selected;
    this.updateable = options.updateable ?? this.updateable;
    this.visible = options.visible ?? this.visible;
    this.handleColor = this.color.clone().darken(0.6);
    this.waveform = waveform;
    this.visualizer = visualizer;
    this.controller = controller;
    this.handleWidth = 2;
    this.isDragging = false;
    this.draggingStartPosition = null;
    this.isGrabbingEdge = { isRightEdge: false, isLeftEdge: false };

    this.initialize();
  }

  get isRegion() {
    return false;
  }

  update(options: Partial<SegmentOptions>) {
    if (!this.updateable && (options.updateable !== undefined && !options.updateable)) return;

    if (options.updateable !== undefined) {
      this.updateable = options.updateable;
    }
    if (options.deleteable !== undefined) {
      this.deleteable = options.deleteable;
    }
    if (options.start !== undefined) {
      this.start = options.start;
    }
    if (options.end !== undefined) {
      this.end = options.end;
    }
    if (options.selected !== undefined) {
      this.selected = options.selected;
    }
    if (options.visible !== undefined) {
      this.visible = options.visible;
    }
    if (options.color !== undefined) {
      this.color = rgba(options.color);
    }
  }

  setVisibility(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;

    this.invoke('update', [this]);
    this.waveform.invoke('regionUpdated', [this]);
  }

  protected get layerName() {
    return `region-${this.id}`;
  }

  private get duration() {
    return this.waveform.duration;
  }

  private get zoom() {
    return this.waveform.zoom;
  }

  get xStart() {
    const { width } = this.visualizer;
    const position = this.visualizer.getScrollLeft();
    const offsetX = (this.start / this.duration * width) - (width * position);

    return offsetX * this.zoom;
  }

  get xEnd() {
    return this.xStart + this.width;
  }

  get width() {
    const { start, end } = this;
    const { width } = this.visualizer;
    const regionWidth = (end - start) / this.waveform.duration * width;

    return regionWidth * this.zoom;
  }

  get hovered() {
    return this.controller.isHovered(this);
  }

  get timelineHeight() {
    return this.visualizer.timelineHeight || defaults.timelineHeight;
  }

  get timelinePlacement() {
    return this.visualizer.timelinePlacement || defaults.timelinePlacement;
  }

  private get inViewport() {
    const { xStart: startX, xEnd: endX } = this;
    const width = this.visualizer.width * this.zoom;

    // Both coordinates are less than or equal to 0
    if (startX <= 0 && endX <= 0) return false;

    // Both coordinates are greater than or equal to the viewport
    if (startX >= width && endX >= width) return false;

    return true;
  }

  private requiresCursorFocus(symbol: CursorSymbol) {
    return ![CursorSymbol.crosshair].includes(symbol);
  }

  switchCursor = (symbol: CursorSymbol, shouldGrabFocus = true) => {
    this.waveform.cursor.set(symbol, shouldGrabFocus && this.requiresCursorFocus(symbol) ? this.layerName : '');
  };

  private edgeGrabCheck = (e: MouseEvent) => {
    const { handleWidth, end, start, visualizer } = this;
    const { zoomedWidth } = this.visualizer;
    const { duration } = this.waveform;
    const cursorTime = getCursorTime(e, visualizer, duration);
    const handleTime = pixelsToTime(handleWidth, zoomedWidth, duration);
    const isRightEdge = cursorTime > end - handleTime;
    const isLeftEdge = cursorTime < start + handleTime;

    return { isRightEdge, isLeftEdge };
  };

  private mouseOver = (_: Segment, e: MouseEvent) => {
    if (!this.updateable || !this.controller.layerGroup.isVisible) return;
    const isEdgeGrab = this.edgeGrabCheck(e);

    if (this.isDragging) return;
    if (isEdgeGrab.isRightEdge || isEdgeGrab.isLeftEdge) this.switchCursor(CursorSymbol.colResize);
    else this.switchCursor(CursorSymbol.grab);
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (!this.updateable) return;

    if (this.isDragging) {
      this.switchCursor(CursorSymbol.grab);
      this.handleUpdateEnd();
    } else {
      this.handleSelected();
      this.waveform.invoke('regionSelected', [this, e]);
    }
    
    this.isDragging = false;
    this.draggingStartPosition = null;
    this.isGrabbingEdge = { isRightEdge: false, isLeftEdge: false };
    document.removeEventListener('mousemove', this.handleDrag);
    document.removeEventListener('mouseup', this.handleMouseUp);
  };

  private handleDrag = (e: MouseEvent) => {
    if (!this.updateable) return;
    if (this.draggingStartPosition) {
      e.preventDefault();
      e.stopPropagation();
      this.isDragging = true;
      const { isRightEdge: freezeStart, isLeftEdge: freezeEnd } = this.isGrabbingEdge; 
      const { grabPosition, start, end } = this.draggingStartPosition;
      const isResizing = freezeStart || freezeEnd;
      const { container, zoomedWidth } = this.visualizer;
      const { duration } = this.waveform;
      const scrollLeft = this.visualizer.getScrollLeft();

      let currentPosition = getCursorPositionX(e, container) + scrollLeft;
      
      if (currentPosition < 0) currentPosition = 0;

      const newPosition = currentPosition - grabPosition; //relative to the grabPosition
      const seconds = pixelsToTime(newPosition, zoomedWidth, duration); //seconds adjusted relative to grabPosition
      const timeDiff = end - start; //segment duration
      const newStart = freezeEnd ? start + seconds : clamp(start + seconds, 0, this.duration - timeDiff);  
      const startTime = freezeStart ? start : newStart;
      const endTime = freezeEnd ? end : clamp(end + seconds, newStart + (isResizing ? 0 : timeDiff), this.duration);

      if (freezeStart || freezeEnd) this.switchCursor(CursorSymbol.colResize);
      else  this.switchCursor(CursorSymbol.grabbing);

      this.updatePosition(clamp(startTime, 0, duration), clamp(endTime, 0, duration));
    }
  };

  private mouseDown = (_: Segment, e: MouseEvent) => {
    if (!this.updateable || !this.controller.layerGroup.isVisible) return;
    if (this.controller.isOverrideKeyPressed(e) || this.controller.isLocked) return;
    const { container } = this.visualizer;
    const scrollLeft = this.visualizer.getScrollLeft();
    const x = getCursorPositionX(e, container) + scrollLeft;
    const { start, end } = this;

    this.draggingStartPosition = { grabPosition: x, start, end };
    this.isGrabbingEdge = this.edgeGrabCheck(e);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousemove', this.handleDrag);
  };

  private initialize() {
    this.layer = this.visualizer.createLayer({ groupName: 'regions', name: this.layerName });
    // Handle region resizing
    this.on('mouseOver', this.mouseOver);
    this.on('mouseDown', this.mouseDown);
  }

  /**
   * Render the region on the canvas
   */
  render() {
    if (!this.visible || !this.inViewport) {
      return;
    }
    // this is here because when the selected region is from a different label from before, it was deselecting everything
    if (this.selected) this.setColorDarken(0.5);

    const { color, handleColor, timelinePlacement, timelineHeight } = this;
    const { height } = this.visualizer;
    const timelineLayer = this.visualizer.getLayer('timeline');
    const timelineTop = timelinePlacement === defaults.timelinePlacement;
    const top = timelineLayer?.isVisible && timelineTop ? timelineHeight : 0;
    const layer = this.controller.layerGroup;

    // @todo - this should account for timeline placement and start at the reservedSpace height
    layer.fillStyle = color.toString();
    layer.fillRect(this.xStart, top, this.width, height);

    // Render grab lines
    layer.fillStyle = handleColor.toString();
    layer.fillRect(this.xStart, top, this.handleWidth, height);
    layer.fillRect(this.xEnd - this.handleWidth, top, this.handleWidth, height);

    // Render label
    // if (this.label) {
    //   layer.font = "12px Arial";
    //   const labelMeasure = layer.context.measureText(this.label);

    //   layer.fillStyle = "#000";
    //   layer.fillRect(
    //     this.startX + 5,
    //     5,
    //     clamp(labelMeasure.width + 10, 0, this.width),
    //     10
    //   );

    //   layer.fillStyle = "#fff";
    //   layer.fitText(this.label, this.startX + 10, 12, this.width);
    // }
  }

  handleUpdateEnd() {
    this.invoke('updateEnd', [this]);
    this.waveform.invoke('regionUpdatedEnd', [this]);
  }

  handleSelected = (selected?: boolean) => {
    if (!this.updateable) return;
    if (this.waveform.playing) this.waveform.player.pause();
    this.selected = selected ?? !this.selected;
    if (selected) this.setColorDarken(0.5);
    else this.color.reset();
    this.invoke('update', [this]);
    this.waveform.invoke('regionUpdated', [this]);
  };

  handleHighlighted = (highlighted?: boolean) => {
    if (!this.updateable || this.selected) return;
    this.highlighted = highlighted ?? !this.highlighted;
    if (this.highlighted) this.setColorDarken(0.5);
    else this.color.reset();
    this.invoke('update', [this]);
    this.waveform.invoke('regionUpdated', [this]);
  };
  
  /**
   * Update region's color
   */

  setColor(color: string|RgbaColorArray) {
    this.color.update(color);
    this.handleColor.update(color).darken(0.6);
  }

  setColorDarken(value: number) {
    if (this.color.rgba === this.color.base) {
      this.color.darken(value);
    }
  }

  updateColor(color: string|RgbaColorArray) {
    if (!this.updateable) return;
    this.setColor(color);
    this.invoke('update', [this]);
    this.waveform.invoke('regionUpdated', [this]);
  }

  updatePosition(start?: number, end?: number) {
    if (!this.updateable) return;
    let newStart = start ?? this.start;
    let newEnd = end ?? this.end;

    if (newStart > newEnd) {
      [newStart, newEnd] = [newEnd, newStart];
    }

    this.start = newStart;
    this.end = newEnd;
    this.invoke('update', [this]);
    this.waveform.invoke('regionUpdated', [this]);
  }

  scrollToRegion() {
    this.waveform.scrollToRegion(this.start);
  }

  remove() {
    if (!this.deleteable) return;
    this.waveform.invoke('regionRemoved', [this]);
  }

  /**
   * Destroy region
   * Remove all event listeners and remove the region from the canvas
   * Remove region's layer
   */
  destroy(notify = true) {
    if (!this.deleteable || this.isDestroyed) return;

    if (notify) {
      this.remove();
    }

    super.destroy();
  }

  toJSON() {
    return {
      start: this.start,
      end: this.end,
    };
  }
}

