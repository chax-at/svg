import { DXF_COLOR_HEX } from '@dxfom/color/hex';
import { getGroupCodeValue, getGroupCodeValues } from '@dxfom/dxf';
import { parseDxfMTextContent } from '@dxfom/mtext';
import { parseDxfTextContent } from '@dxfom/text';

const smallNumber = 1 / 64;
const nearlyEqual = (a, b) => Math.abs(a - b) < smallNumber;
const round = (() => {
  const _shift = (n, precision) => {
    const [d, e] = ('' + n).split('e');
    return +(d + 'e' + (e ? +e + precision : precision));
  };

  return (n, precision) => _shift(Math.round(_shift(n, precision)), -precision);
})();
const trim = s => s ? s.trim() : s;
const $trim = (record, groupCode) => trim(getGroupCodeValue(record, groupCode));
const $number = (record, groupCode, defaultValue) => {
  const value = +getGroupCodeValue(record, groupCode);

  if (isNaN(value)) {
    return defaultValue === undefined ? NaN : defaultValue;
  }

  if (Math.abs(value) > 1e6) {
    throw Error(`group code ${groupCode} is invalid (${value})`);
  }

  const rounded = Math.round(value);
  return Math.abs(rounded - value) < 1e-8 ? rounded : value;
};
const $numbers = (record, ...groupCodes) => groupCodes.map(groupCode => $number(record, groupCode));
const $negates = (record, ...groupCodes) => groupCodes.map(groupCode => -$number(record, groupCode));

const DimStyles = {
  DIMSCALE: [40, 40, 1],
  DIMTP: [47, 40, NaN],
  DIMTM: [48, 40, NaN],
  DIMTOL: [71, 70, 0],
  DIMTXT: [140, 40, 1],
  DIMLFAC: [144, 40, 1],
  DIMCLRT: [178, 70, NaN],
  DIMDEC: [271, 70, 4]
};

const collectDimensionStyleOverrides = d => {
  const result = new Map();

  for (let i = 0; i < d.length; i++) {
    if (d[i][0] === 1000 && d[i][1].trim() === 'DSTYLE' && d[i + 1][0] === 1002 && d[i + 1][1].trim() === '{') {
      for (let j = i + 2; j < d.length; j++) {
        if (d[j][0] === 1002) {
          break;
        }

        if (d[j][0] === 1070) {
          result.set(+d[j][1], d[++j][1]);
        }
      }

      return result;
    }
  }
};

const collectDimensionStyles = (dxf, dimension) => {
  const styleName = getGroupCodeValue(dimension, 3);
  const style = dxf.TABLES?.DIMSTYLE?.find(style => getGroupCodeValue(style, 2) === styleName);
  const styleOverrides = collectDimensionStyleOverrides(dimension);
  const styles = Object.create(null);

  for (const [variableName, [groupCode, headerGroupCode, defaultValue]] of Object.entries(DimStyles)) {
    const value = styleOverrides?.get(groupCode) ?? getGroupCodeValue(style, groupCode) ?? getGroupCodeValue(dxf.HEADER?.['$' + variableName], headerGroupCode);
    styles[variableName] = value !== undefined ? +value : defaultValue;
  }

  return styles;
};

const toleranceString = n => n > 0 ? '+' + n : n < 0 ? String(n) : ' 0';

const dimensionValueToMText = (measurement, dimension, styles) => {
  const savedValue = $number(dimension, 42, -1);
  const value = round(savedValue !== -1 ? savedValue : measurement * styles.DIMLFAC, styles.DIMDEC);
  let valueWithTolerance = String(value);

  if (styles.DIMTOL) {
    const p = styles.DIMTP;
    const n = styles.DIMTM;

    if (p || n) {
      if (p === n) {
        valueWithTolerance = `${value}  ±${p}`;
      } else {
        valueWithTolerance = `${value}  {\\S${toleranceString(p)}^${toleranceString(-n)};}`;
      }
    }
  }

  const template = getGroupCodeValue(dimension, 1);
  return template ? template.replace(/<>/, valueWithTolerance) : valueWithTolerance;
};

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const jsx = (type, props) => {
  let s = '<' + type;
  let children;

  for (const [key, value] of Object.entries(props)) {
    if (!value) {
      continue;
    }

    if (key === 'children') {
      children = value;
    } else {
      s += ` ${key}="${typeof value === 'string' ? escapeHtml(value) : value}"`;
    }
  }

  if (type === 'line' || type === 'polyline' || type === 'polygon' || type === 'circle' || type === 'path') {
    if (!props.fill) {
      s += ' fill="none"';
    }

    s += ' vector-effect="non-scaling-stroke"';
  }

  if (type === 'text') {
    s += ' stroke="none" style="white-space:pre"';
  }

  if (children) {
    s += `>${Array.isArray(children) ? children.join('') : children}</${type}>`;
  } else {
    s += '/>';
  }

  return s;
};
const jsxs = jsx;

const MTEXT_attachmentPoint = n => {
  n = +n;
  let dominantBaseline;
  let textAnchor;

  switch (n) {
    case 1:
    case 2:
    case 3:
      dominantBaseline = 'text-before-edge';
      break;

    case 4:
    case 5:
    case 6:
      dominantBaseline = 'central';
      break;

    case 7:
    case 8:
    case 9:
      dominantBaseline = 'text-after-edge';
      break;
  }

  switch (n % 3) {
    case 2:
      textAnchor = 'middle';
      break;

    case 0:
      textAnchor = 'end';
      break;
  }

  return {
    dominantBaseline,
    textAnchor
  };
};

const yx2angle = (y, x) => round(Math.atan2(y || 0, x || 0) * 180 / Math.PI, 5) || 0;

const MTEXT_angle = mtext => {
  for (let i = mtext.length - 1; i >= 0; i--) {
    switch (mtext[i][0]) {
      case 50:
        return round(+mtext[i][1], 5) || 0;

      case 11:
        return yx2angle($number(mtext, 12), +mtext[i][1]);

      case 21:
        return yx2angle(+mtext[i][1], $number(mtext, 11));
    }
  }

  return 0;
};
const MTEXT_contents = (contents, options, i = 0) => {
  if (contents.length <= i) {
    return '';
  }

  const restContents = MTEXT_contents(contents, options, i + 1);
  const content = contents[i];

  if (typeof content === 'string') {
    return content + restContents;
  }

  if (Array.isArray(content)) {
    return MTEXT_contents(content, options) + restContents;
  }

  if (content.S) {
    return jsxs("tspan", {
      children: [jsx("tspan", {
        dy: "-.5em",
        children: content.S[0]
      }), jsx("tspan", {
        dy: "1em",
        dx: content.S[0].length / -2 + 'em',
        children: content.S[2]
      })]
    }) + restContents;
  }

  if (content.f) {
    const _font = {
      family: content.f,
      weight: content.b ? 700 : 400,
      style: content.i ? 'italic' : undefined
    };

    const font = options?.resolveFont?.(_font) ?? _font;

    return jsx("tspan", {
      "font-family": font.family,
      "font-weight": font.weight,
      "font-style": font.style,
      "font-size": font.scale && font.scale !== 1 ? font.scale + 'em' : undefined,
      children: restContents
    });
  }

  if (content.Q) {
    return jsx("tspan", {
      "font-style": `oblique ${content.Q}deg`,
      children: restContents
    });
  }

  return restContents;
};

const defaultOptions = {
  warn: console.debug,
  resolveColorIndex: index => DXF_COLOR_HEX[index] ?? '#888'
};

const commonAttributes = entity => ({
  'data-5': $trim(entity, 5)
});

const textDecorations = ({
  k,
  o,
  u
}) => {
  const decorations = [];
  k && decorations.push('line-through');
  o && decorations.push('overline');
  u && decorations.push('underline');
  return decorations.join(' ');
};

const TEXT_dominantBaseline = [, 'text-after-edge', 'central', 'text-before-edge'];
const TEXT_textAnchor = [, 'middle', 'end',, 'middle'];

const polylinePoints = (xs, ys) => {
  let points = '';

  for (let i = 0; i < xs.length; i++) {
    points += `${xs[i]},${ys[i]} `;
  }

  return points.slice(0, -1);
};

const createEntitySvgMap = (dxf, options) => {
  const {
    warn,
    resolveColorIndex
  } = options;
  const layerMap = {};

  for (const layer of dxf.TABLES?.LAYER ?? []) {
    if (getGroupCodeValue(layer, 0) === 'LAYER') {
      layerMap[getGroupCodeValue(layer, 2)] = {
        color: resolveColorIndex(+getGroupCodeValue(layer, 62)),
        ltype: getGroupCodeValue(layer, 6)
      };
    }
  }

  const ltypeMap = {};

  for (const ltype of dxf.TABLES?.LTYPE ?? []) {
    if (getGroupCodeValue(ltype, 0) === 'LTYPE') {
      const _strokeDasharray = getGroupCodeValues(ltype, 49).map(trim).map(s => s.startsWith('-') ? s.slice(1) : s);

      const strokeDasharray = _strokeDasharray.length === 0 || _strokeDasharray.length % 2 === 1 ? _strokeDasharray : _strokeDasharray[0] === '0' ? _strokeDasharray.slice(1) : _strokeDasharray.concat('0');
      strokeDasharray.length !== 0 && (ltypeMap[getGroupCodeValue(ltype, 2)] = {
        strokeDasharray: strokeDasharray.join(' ')
      });
    }
  }

  const _color = entity => {
    const colorIndex = $trim(entity, 62);

    if (colorIndex === '0') {
      return 'currentColor';
    }

    if (colorIndex && colorIndex !== '256') {
      return resolveColorIndex(+colorIndex);
    }

    const layer = layerMap[$trim(entity, 8)];

    if (layer) {
      return layer.color;
    }
  };

  const color = entity => _color(entity) || 'currentColor';

  const strokeDasharray = entity => ltypeMap[getGroupCodeValue(entity, 6) ?? layerMap[getGroupCodeValue(entity, 8)]?.ltype]?.strokeDasharray;

  const extrusionStyle = entity => {
    const extrusionZ = +$trim(entity, 230);

    if (extrusionZ && Math.abs(extrusionZ + 1) < 1 / 64) {
      return 'transform:rotateY(180deg)';
    }
  };

  const lineAttributes = entity => Object.assign(commonAttributes(entity), {
    stroke: color(entity),
    'stroke-dasharray': strokeDasharray(entity),
    style: extrusionStyle(entity)
  });

  return {
    POINT: () => undefined,
    LINE: entity => {
      const xs = $numbers(entity, 10, 11);
      const ys = $negates(entity, 20, 21);
      return [jsx("line", { ...lineAttributes(entity),
        x1: xs[0],
        y1: ys[0],
        x2: xs[1],
        y2: ys[1]
      }), xs, ys];
    },
    POLYLINE: (entity, vertices) => {
      const xs = vertices.map(v => $number(v, 10));
      const ys = vertices.map(v => -$number(v, 20));
      const flags = +(getGroupCodeValue(entity, 70) ?? 0);
      const attrs = Object.assign(lineAttributes(entity), {
        points: polylinePoints(xs, ys)
      });
      return [flags & 1 ? jsx("polygon", { ...attrs
      }) : jsx("polyline", { ...attrs
      }), xs, ys];
    },
    LWPOLYLINE: entity => {
      const xs = getGroupCodeValues(entity, 10).map(s => +s);
      const ys = getGroupCodeValues(entity, 20).map(s => -s);
      const flags = +(getGroupCodeValue(entity, 70) ?? 0);
      const attrs = Object.assign(lineAttributes(entity), {
        points: polylinePoints(xs, ys)
      });
      return [flags & 1 ? jsx("polygon", { ...attrs
      }) : jsx("polyline", { ...attrs
      }), xs, ys];
    },
    CIRCLE: entity => {
      const [cx, cy, r] = $numbers(entity, 10, 20, 40);
      return [jsx("circle", { ...lineAttributes(entity),
        cx: cx,
        cy: -cy,
        r: r
      }), [cx - r, cx + r], [-cy - r, -cy + r]];
    },
    ARC: entity => {
      const [cx, cy, r] = $numbers(entity, 10, 20, 40);
      const deg1 = $number(entity, 50, 0);
      const deg2 = $number(entity, 51, 0);
      const rad1 = deg1 * Math.PI / 180;
      const rad2 = deg2 * Math.PI / 180;
      const x1 = cx + r * Math.cos(rad1);
      const y1 = cy + r * Math.sin(rad1);
      const x2 = cx + r * Math.cos(rad2);
      const y2 = cy + r * Math.sin(rad2);
      const large = (deg2 - deg1 + 360) % 360 <= 180 ? '0' : '1';
      return [jsx("path", { ...lineAttributes(entity),
        d: `M${x1} ${-y1}A${r} ${r} 0 ${large} 0 ${x2} ${-y2}`
      }), [x1, x2], [-y1, -y2]];
    },
    ELLIPSE: entity => {
      // https://wiki.gz-labs.net/index.php/ELLIPSE
      const rad1 = $number(entity, 41, 0);
      const rad2 = $number(entity, 42, 2 * Math.PI);

      if (nearlyEqual(rad1, 0) && nearlyEqual(rad2, 2 * Math.PI)) {
        const [cx, cy, majorX, majorY] = $numbers(entity, 10, 20, 11, 21);
        const majorR = Math.hypot(majorX, majorY);
        const minorR = $number(entity, 40) * majorR;
        const radAngleOffset = -Math.atan2(majorY, majorX);
        const transform = radAngleOffset ? `rotate(${radAngleOffset * 180 / Math.PI} ${cx} ${-cy})` : undefined;
        return [jsx("ellipse", { ...lineAttributes(entity),
          cx: cx,
          cy: -cy,
          rx: majorR,
          ry: minorR,
          transform: transform
        }), [cx - majorR, cx + majorR], [-cy - minorR, -cy + minorR]];
      } else {
        warn('Elliptical arc cannot be rendered yet.');
      }
    },
    LEADER: entity => {
      const xs = getGroupCodeValues(entity, 10).map(s => +s);
      const ys = getGroupCodeValues(entity, 20).map(s => -s);
      return [jsx("polyline", { ...commonAttributes(entity),
        points: polylinePoints(xs, ys),
        stroke: color(entity),
        "stroke-dasharray": strokeDasharray(entity)
      }), xs, ys];
    },
    HATCH: entity => {
      const paths = entity.slice(entity.findIndex(groupCode => groupCode[0] === 92), entity.findIndex(groupCode => groupCode[0] === 97));
      const x1s = getGroupCodeValues(paths, 10).map(s => +s);
      const y1s = getGroupCodeValues(paths, 20).map(s => -s);
      const x2s = getGroupCodeValues(paths, 11).map(s => +s);
      const y2s = getGroupCodeValues(paths, 21).map(s => -s);
      let d = '';

      for (let i = 0; i < x1s.length; i++) {
        if (!x2s[i]) {
          d += `${i === 0 ? 'M' : 'L'}${x1s[i]} ${y1s[i]}`;
        } else if (x1s[i] === x2s[i - 1] && y1s[i] === y2s[i - 1]) {
          d += `L${x2s[i]} ${y2s[i]}`;
        } else {
          d += `M${x1s[i]} ${y1s[i]}L${x2s[i]} ${y2s[i]}`;
        }
      }

      return [jsx("path", { ...commonAttributes(entity),
        d: d,
        fill: color(entity),
        "fill-opacity": ".3"
      }), [...x1s, ...x2s], [...y1s, ...y2s]];
    },
    SOLID: entity => {
      const [x1, x2, x3, x4] = $numbers(entity, 10, 11, 12, 13);
      const [y1, y2, y3, y4] = $negates(entity, 20, 21, 22, 23);
      const d = `M${x1} ${y1}L${x2} ${y2}L${x3} ${y3}${x3 !== x4 || y3 !== y4 ? `L${x4} ${y4}` : ''}Z`;
      return [jsx("path", { ...commonAttributes(entity),
        d: d,
        fill: color(entity)
      }), [x1, x2, x3, x4], [y1, y2, y3, y4]];
    },
    TEXT: entity => {
      const [x, h] = $numbers(entity, 10, 40);
      const [y, angle] = $negates(entity, 20, 50);
      const contents = parseDxfTextContent(getGroupCodeValue(entity, 1) || '', options);
      return [jsx("text", { ...commonAttributes(entity),
        x: x,
        y: y,
        fill: color(entity),
        "font-size": h,
        "dominant-baseline": TEXT_dominantBaseline[$trim(entity, 73)],
        "text-anchor": TEXT_textAnchor[$trim(entity, 72)],
        transform: angle && `rotate(${angle} ${x} ${y})`,
        "text-decoration": contents.length === 1 && textDecorations(contents[0]),
        children: contents.length === 1 ? contents[0].text : contents.map(content => jsx("tspan", {
          "text-decoration": textDecorations(content),
          children: content.text
        }))
      }), [x, x + h * contents.length], [y, y + h]];
    },
    MTEXT: entity => {
      const [x, h] = $numbers(entity, 10, 40);
      const y = -$number(entity, 20);
      const angle = MTEXT_angle(entity);
      const {
        dominantBaseline,
        textAnchor
      } = MTEXT_attachmentPoint($trim(entity, 71));
      const contents = getGroupCodeValues(entity, 3).join('') + (getGroupCodeValue(entity, 1) ?? '');
      return [jsx("text", { ...commonAttributes(entity),
        x: x,
        y: y,
        fill: color(entity),
        "font-size": h,
        "dominant-baseline": dominantBaseline,
        "text-anchor": textAnchor,
        transform: angle ? `rotate(${-angle} ${x} ${y})` : undefined,
        children: MTEXT_contents(parseDxfMTextContent(contents, options), options)
      }), [x, x + h * contents.length], [y, y + h]];
    },
    DIMENSION: entity => {
      const dimStyles = collectDimensionStyles(dxf, entity);
      let lineElements = '';
      let measurement;
      let dominantBaseline = 'text-after-edge';
      let textAnchor = 'middle';
      let angle;
      const tx = $number(entity, 11);
      const ty = -$number(entity, 21);
      const xs = [tx];
      const ys = [ty];
      const dimensionType = $number(entity, 70, 0);

      switch (dimensionType & 7) {
        case 0: // Rotated, Horizontal, or Vertical

        case 1:
          // Aligned
          {
            const [x0, x1, x2] = $numbers(entity, 10, 13, 14);
            const [y0, y1, y2] = $negates(entity, 20, 23, 24);
            angle = Math.round(-$number(entity, 50, 0) || 0);

            if (angle % 180 === 0) {
              measurement = Math.abs(x1 - x2);
              lineElements = jsx("path", {
                stroke: "currentColor",
                d: `M${x1} ${y1}L${x1} ${y0}L${x2} ${y0}L${x2} ${y2}`
              });
              angle = 0;
            } else {
              measurement = Math.abs(y1 - y2);
              lineElements = jsx("path", {
                stroke: "currentColor",
                d: `M${x1} ${y1}L${x0} ${y1}L${x0} ${y2}L${x2} ${y2}`
              });
            }

            xs.push(x1, x2);
            ys.push(y1, y2);
            break;
          }

        case 2: // Angular

        case 5:
          // Angular 3-point
          warn('Angular dimension cannot be rendered yet.', entity);
          return;

        case 3: // Diameter

        case 4:
          // Radius
          {
            const [x0, x1] = $numbers(entity, 10, 15);
            const [y0, y1] = $negates(entity, 20, 25);
            measurement = Math.hypot(x0 - x1, y0 - y1);
            lineElements = jsx("path", {
              stroke: "currentColor",
              d: `M${x1} ${y1}L${tx} ${ty}`
            });
            xs.push(x0, x1);
            ys.push(y0, y1);
            break;
          }

        case 6:
          // Ordinate
          {
            const [x1, x2] = $numbers(entity, 13, 14);
            const [y1, y2] = $negates(entity, 23, 24);

            if (dimensionType & 64) {
              const x0 = $number(entity, 10);
              measurement = Math.abs(x0 - +x1);
              lineElements = jsx("path", {
                stroke: "currentColor",
                d: `M${x1} ${y1}L${x1} ${y2}L${x2} ${y2}L${tx} ${ty}`
              });
              angle = -90;
            } else {
              const y0 = -$number(entity, 20);
              measurement = Math.abs(y0 - +y1);
              lineElements = jsx("path", {
                stroke: "currentColor",
                d: `M${x1} ${y1}L${x2} ${y1}L${x2} ${y2}L${tx} ${ty}`
              });
            }

            dominantBaseline = 'central';
            textAnchor = 'middle';
            xs.push(x1, x2);
            ys.push(y1, y2);
            break;
          }

        default:
          warn('Unknown dimension type.', entity);
          return;
      }

      let textElement;
      {
        const mtext = dimensionValueToMText(measurement, entity, dimStyles);
        const h = dimStyles.DIMTXT * dimStyles.DIMSCALE;
        const textColor = dimStyles.DIMCLRT;
        textElement = jsx("text", {
          x: tx,
          y: ty,
          fill: isNaN(textColor) ? color(entity) : textColor === 0 ? 'currentColor' : resolveColorIndex(textColor),
          "font-size": h,
          "dominant-baseline": dominantBaseline,
          "text-anchor": textAnchor,
          transform: angle && `rotate(${angle} ${tx} ${ty})`,
          children: MTEXT_contents(parseDxfMTextContent(mtext, options), options)
        });
      }
      return [jsx("g", { ...commonAttributes(entity),
        color: color(entity),
        "stroke-dasharray": strokeDasharray(entity),
        style: extrusionStyle(entity),
        children: lineElements + textElement
      }), xs, ys];
    },
    ACAD_TABLE: entity => {
      const cells = [];
      {
        let index = entity.findIndex(groupCode => groupCode[0] === 171);

        for (let i = index + 1; i < entity.length; i++) {
          if (entity[i][0] === 171) {
            cells.push(entity.slice(index, i));
            index = i;
          }
        }

        cells.push(entity.slice(index, entity.length));
      }
      const ys = getGroupCodeValues(entity, 141).map(s => +s).reduce((ys, size) => (ys.push(ys[ys.length - 1] + size), ys), [0]);
      const xs = getGroupCodeValues(entity, 142).map(s => +s).reduce((xs, size) => (xs.push(xs[xs.length - 1] + size), xs), [0]);
      const lineColor = color(entity);
      const textColor = resolveColorIndex(+getGroupCodeValue(entity, 64));
      let s = ys.map(y => jsx("line", {
        stroke: lineColor,
        x1: "0",
        y1: y,
        x2: xs[xs.length - 1],
        y2: y
      })).join('');
      let xi = 0;
      let yi = 0;

      for (const cell of cells) {
        const x = xs[xi];
        const y = ys[yi];
        const color = +getGroupCodeValue(cell, 64);

        if (!+getGroupCodeValue(cell, 173)) {
          s += jsx("line", {
            x1: x,
            y1: y,
            x2: x,
            y2: ys[yi + 1],
            stroke: lineColor
          });
        }

        if ($trim(cell, 171) === '2') {
          warn('Table cell type "block" cannot be rendered yet.', entity, cell);
        } else {
          s += jsx("text", {
            x: x,
            y: y,
            fill: !isNaN(color) ? resolveColorIndex(color) : textColor,
            children: MTEXT_contents(parseDxfMTextContent(getGroupCodeValue(cell, 1) ?? ''), options)
          });
        }

        if (++xi === xs.length - 1) {
          xi = 0;
          yi++;
        }
      }

      s += jsx("line", {
        x1: xs[xs.length - 1],
        y1: "0",
        x2: xs[xs.length - 1],
        y2: ys[ys.length - 1],
        stroke: lineColor
      });
      const x = $number(entity, 10);
      const y = -$number(entity, 20);
      return [jsx("g", { ...commonAttributes(entity),
        "font-size": $trim(entity, 140),
        "dominant-baseline": "text-before-edge",
        transform: `translate(${x},${y})`,
        children: s
      }), xs.map(_x => _x + x), ys.map(_y => _y + y)];
    },
    INSERT: entity => {
      const x = $number(entity, 10, 0);
      const y = -$number(entity, 20, 0);
      const rotate = -$number(entity, 50);
      const xscale = $number(entity, 41, 1) || 1;
      const yscale = $number(entity, 42, 1) || 1;
      const transform = [x || y ? `translate(${x},${y})` : '', xscale !== 1 || yscale !== 1 ? `scale(${xscale},${yscale})` : '', rotate ? `rotate(${rotate})` : ''].filter(Boolean).join(' ');

      const _block = dxf.BLOCKS?.[getGroupCodeValue(entity, 2)];

      const block = _block?.slice(getGroupCodeValue(_block[0], 0) === 'BLOCK' ? 1 : 0, getGroupCodeValue(_block[_block.length - 1], 0) === 'ENDBLK' ? -1 : undefined);
      const [contents, bbox] = entitiesSvg(dxf, block, options);
      return [jsx("g", { ...commonAttributes(entity),
        color: _color(entity),
        transform: transform,
        children: contents
      }), [x + bbox.x * xscale, x + (bbox.x + bbox.w) * xscale], [y + bbox.y * yscale, y + (bbox.y + bbox.h) * yscale]];
    }
  };
};

const entitiesSvg = (dxf, entities, options) => {
  const {
    warn
  } = options;
  const entitySvgMap = createEntitySvgMap(dxf, options);
  let s = '';
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  if (entities) {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const entityType = getGroupCodeValue(entity, 0);

      if (!entityType) {
        continue;
      }

      const vertices = [];

      while (getGroupCodeValue(entities[i + 1], 0) === 'VERTEX') {
        vertices.push(entities[++i]);
      }

      if (vertices.length !== 0 && getGroupCodeValue(entities[i + 1], 0) === 'SEQEND') {
        i++;
      }

      try {
        const entitySvg = entitySvgMap[entityType];

        if (entitySvg) {
          const svg = entitySvg(entity, vertices);

          if (svg) {
            s += svg[0];
            const xs = svg[1].filter(x => isFinite(x));
            const ys = svg[2].filter(y => isFinite(y));
            minX = Math.min(minX, ...xs);
            maxX = Math.max(maxX, ...xs);
            minY = Math.min(minY, ...ys);
            maxY = Math.max(maxY, ...ys);
          }
        } else {
          warn(`Unknown entity type: ${entityType}`, entity);
        }
      } catch (error) {
        warn(`Error occurred: ${error}`, entity);
      }
    }
  }

  return [s, {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY
  }];
};

const createSvgContents = (dxf, options) => {
  const resolvedOptions = options ? { ...defaultOptions,
    ...options
  } : defaultOptions;
  return entitiesSvg(dxf, dxf.ENTITIES, resolvedOptions);
};

const createSvgString = (dxf, options) => {
  const [s, {
    x,
    y,
    w,
    h
  }] = createSvgContents(dxf, options);
  return jsx("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: `${x} ${y} ${w} ${h}`,
    width: w,
    height: h,
    children: s
  });
};

export { createSvgContents, createSvgString };
