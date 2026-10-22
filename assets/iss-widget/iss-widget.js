/*
 * Виджет "МКС и TERRA сейчас" для сайта RUDN-QGIS-ORBIT-L1.
 *
 * Положение КА рассчитывается прямо в браузере по TLE (модель SGP4, библиотека satellite.js)
 * - так же, как это делает Python-скрипт лабораторной работы (библиотека pyorbital).
 * Карта - MapLibre GL JS (плоская карта в проекции Веб-Меркатор или глобус).
 * TLE берутся из файла tle.json, лежащего рядом с этим скриптом.
 *
 * Подключение на странице:
 *   <div class="iss-widget"></div>
 *   + vendor/maplibre-gl.css, iss-widget.css, vendor/maplibre-gl.js, vendor/satellite.min.js, iss-widget.js
 */
(function () {
  'use strict';

  // Папка, из которой загружен этот скрипт (рядом лежит tle.json)
  var SCRIPT_SRC = document.currentScript ? document.currentScript.src : '';
  var BASE_URL = SCRIPT_SRC.replace(/[^\/]*$/, '');

  var DEG = Math.PI / 180;
  var R_EARTH = 6371.0;          // средний радиус Земли, км (для зоны радиовидимости)
  var TRACK_STEP_SEC = 30;       // шаг расчета трассы, с (как в лабораторной работе)
  var TRACK_PAST_ORBITS = 1;     // пройденная часть трассы, витков
  var TRACK_FUTURE_ORBITS = 1.5; // будущая часть трассы, витков
  var FOOTPRINT_STEP = 0.5;      // шаг точек по азимуту на границе зоны радиовидимости, град.
  var FOOTPRINT_MAX_DLON = 0.5;  // наибольшая разница долгот соседних точек границы зоны, град.
  var SLOW_UPDATE_SEC = 30;      // как часто пересчитывать границу дня/ночи, с (трасса - каждую секунду)

  // Подложки: id слоя -> настройки
  var BASEMAPS = {
    osm: {
      label: 'Карта OpenStreetMap',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">Участники OpenStreetMap</a>',
      imagery: false
    },
    google: {
      label: 'Космоснимки Google',
      tiles: ['https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
              'https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
      maxzoom: 20,
      attribution: 'Космоснимки &copy; Google',
      imagery: true
    }
    // Слой "Космоснимки ESRI" (server.arcgisonline.com) убран: без VPN из России грузится крайне плохо
  };

  // Цвета трассы и тени для карты и для космоснимков
  var COLORS = {
    map:     { track: '#d62828', ring: '#155799', night: 0.30 },
    imagery: { track: '#ffd60a', ring: '#7fd3ff', night: 0.45 }
  };

  // Подписи элементов управления MapLibre на русском
  var MAP_LOCALE = {
    'NavigationControl.ZoomIn': 'Приблизить',
    'NavigationControl.ZoomOut': 'Отдалить',
    'NavigationControl.ResetBearing': 'Сбросить поворот',
    'FullscreenControl.Enter': 'Во весь экран',
    'FullscreenControl.Exit': 'Выйти из полноэкранного режима',
    'AttributionControl.ToggleAttribution': 'Источники данных',
    'AttributionControl.MapFeedback': 'Сообщить об ошибке на карте'
  };

  // ---------------------------------------------------------------- Вспомогательные функции

  function normLon(lon) {
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return lon === -180 ? 180 : lon;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtNum(x, digits) { return x.toFixed(digits).replace('.', ','); }

  function fmtInt(x) { return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  function fmtTime(d, offsetHours) {
    var t = new Date(d.getTime() + (offsetHours || 0) * 3600000);
    return pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes()) + ':' + pad2(t.getUTCSeconds());
  }

  function fmtDate(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // Выравнивание целой части "цифровыми" пробелами (U+2007, шириной ровно в одну цифру),
  // чтобы числа в панели не сдвигались при смене количества знаков: " 5,12" / "45,12"
  function padFig(s, intDigits) {
    var n = intDigits - s.split(',')[0].length;
    return (n > 0 ? new Array(n + 1).join(' ') : '') + s;
  }

  function fmtLat(lat) { return padFig(fmtNum(Math.abs(lat), 2), 2) + '° ' + (lat >= 0 ? 'с.ш.' : 'ю.ш.'); }
  function fmtLon(lon) { return padFig(fmtNum(Math.abs(lon), 2), 3) + '° ' + (lon >= 0 ? 'в.д.' : 'з.д.'); }

  function fmtAge(ms) {
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'менее часа назад';
    var d = Math.floor(h / 24);
    h = h % 24;
    return (d > 0 ? d + ' сут ' : '') + h + ' ч назад';
  }

  // Разбиение линии на антимеридиане ±180° - тот же прием, что и в лабораторной работе
  // (алгоритм QGIS "Геодезическая линия, разделенная на 180° меридиане"), только по прямой
  function splitAtAntimeridian(pts) {
    var lines = [], cur = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var x1 = pts[i - 1][0], y1 = pts[i - 1][1], x2 = pts[i][0], y2 = pts[i][1];
      var dx = x2 - x1;
      if (Math.abs(dx) > 180) {
        var edge = dx < 0 ? 180 : -180;
        var x2u = dx < 0 ? x2 + 360 : x2 - 360;
        var yc = y1 + (edge - x1) / (x2u - x1) * (y2 - y1);
        cur.push([edge, yc]);
        lines.push(cur);
        cur = [[-edge, yc], [x2, y2]];
      } else {
        cur.push([x2, y2]);
      }
    }
    lines.push(cur);
    return lines.filter(function (l) { return l.length > 1; });
  }

  function multiLine(lines) {
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // ---------------------------------------------------------------- Солнце

  // Склонение Солнца и долгота подсолнечной точки (точность ~0,01°, достаточно для карты)
  function sunPosition(date) {
    var d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // сутки от эпохи J2000
    var g = (357.529 + 0.98560028 * d) * DEG;                   // средняя аномалия
    var q = 280.459 + 0.98564736 * d;                           // средняя долгота
    var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG; // эклиптическая долгота
    var e = (23.439 - 0.00000036 * d) * DEG;                    // наклон эклиптики
    var ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
    var dec = Math.asin(Math.sin(e) * Math.sin(L)) / DEG;
    var gmst = 280.46061837 + 360.98564736629 * d;              // звездное время Гринвича, град.
    return { dec: dec, lon: normLon(ra - gmst) };
  }

  // Зенитный угол Солнца в точке (геометрический, по центру диска - как в pyorbital)
  function sunZenith(sun, lat, lon) {
    var c = Math.sin(lat * DEG) * Math.sin(sun.dec * DEG) +
            Math.cos(lat * DEG) * Math.cos(sun.dec * DEG) * Math.cos((lon - sun.lon) * DEG);
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  }

  // Ночная сторона Земли: многоугольник от линии терминатора до полюса, где сейчас ночь
  function nightPolygon(sun) {
    var dec = Math.abs(sun.dec) < 0.01 ? 0.01 : sun.dec;
    var tanDec = Math.tan(dec * DEG);
    var ring = [];
    for (var lon = -180; lon <= 180; lon += 2) {
      var lat = Math.atan(-Math.cos((lon - sun.lon) * DEG) / tanDec) / DEG;
      ring.push([lon, lat]);
    }
    var pole = dec > 0 ? -90 : 90;
    ring.push([180, pole], [-180, pole], ring[0]);
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  // ---------------------------------------------------------------- КА

  function makeSat(rec) {
    var satrec = satellite.twoline2satrec(rec.line1, rec.line2);
    return {
      id: rec.id,
      name: rec.name,
      norad: rec.norad,
      satrec: satrec,
      epoch: new Date((satrec.jdsatepoch - 2440587.5) * 86400000),
      periodMin: 2 * Math.PI / satrec.no,        // период обращения, мин
      inclination: satrec.inclo / DEG            // наклонение, град.
    };
  }

  // Положение КА на момент date: широта, долгота, высота (км), скорость (км/с)
  function satState(sat, date) {
    var pv = satellite.propagate(sat.satrec, date);
    if (!pv || !pv.position) return null;
    var geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    var v = pv.velocity;
    return {
      lat: geo.latitude / DEG,
      lon: normLon(geo.longitude / DEG),
      alt: geo.height,
      speed: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    };
  }

  function trackPoints(sat, from, to) {
    var pts = [], t;
    for (t = from.getTime(); t < to.getTime(); t += TRACK_STEP_SEC * 1000) {
      var s = satState(sat, new Date(t));
      if (s) pts.push([s.lon, s.lat]);
    }
    // Последняя точка - ровно на момент "to", чтобы пройденная и будущая части трассы смыкались
    var e = satState(sat, to);
    if (e) pts.push([e.lon, e.lat]);
    return pts;
  }

  // Зона радиовидимости: круг на поверхности Земли, из любой точки которого КА виден над горизонтом
  function footprint(state) {
    var lam0 = Math.acos(R_EARTH / (R_EARTH + state.alt)); // угловой радиус зоны, рад
    var phi1 = state.lat * DEG, lon1 = state.lon * DEG, pts = [];

    // Точка границы зоны по азимуту az (град.) от подспутниковой точки
    function edge(az) {
      var th = az * DEG;
      var phi2 = Math.asin(Math.sin(phi1) * Math.cos(lam0) + Math.cos(phi1) * Math.sin(lam0) * Math.cos(th));
      var lon2 = lon1 + Math.atan2(Math.sin(th) * Math.sin(lam0) * Math.cos(phi1),
                                   Math.cos(lam0) - Math.sin(phi1) * Math.sin(phi2));
      return [normLon(lon2 / DEG), phi2 / DEG];
    }

    // MapLibre соединяет точки отрезками "по карте" (в координатах широта/долгота). Если край
    // зоны проходит близко к полюсу, соседние точки сильно расходятся по долготе, и отрезок
    // между ними рисуется дугой вокруг полюса. Поэтому там, где разница долгот больше
    // FOOTPRINT_MAX_DLON, вставляем промежуточные точки (делением шага по азимуту пополам)
    function refine(a1, p1, a2, p2, depth) {
      var dLon = Math.abs(p2[0] - p1[0]);
      if (dLon > 180) dLon = 360 - dLon;
      if (dLon <= FOOTPRINT_MAX_DLON || depth >= 12) return;
      var am = (a1 + a2) / 2, pm = edge(am);
      refine(a1, p1, am, pm, depth + 1);
      pts.push(pm);
      refine(am, pm, a2, p2, depth + 1);
    }

    var prev = edge(0);
    pts.push(prev);
    for (var a = FOOTPRINT_STEP; a <= 360 + 1e-9; a += FOOTPRINT_STEP) {
      var cur = edge(a);
      refine(a - FOOTPRINT_STEP, prev, a, cur, 0);
      pts.push(cur);
      prev = cur;
    }
    var lines = splitAtAntimeridian(pts);
    var containsPole = Math.abs(state.lat) + lam0 / DEG > 90;
    var fill = (lines.length === 1 && !containsPole)
      ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [lines[0]] } }
      : null;
    return { line: multiLine(lines), fill: fill, radiusKm: R_EARTH * lam0 };
  }

  // ---------------------------------------------------------------- Значки

  // Значки - отдельные SVG-файлы в папке icons/ (рядом с этим скриптом).
  // Для КА: файл и размер на карте в пикселях; id - как в tle.json
  var ICON_DIR = BASE_URL + 'icons/';
  var SAT_ICONS = {
    ISS:   { file: 'iss.svg',   width: 58, height: 29 },
    TERRA: { file: 'terra.svg', width: 50, height: 23 }
  };
  var DEFAULT_SAT_ICON = SAT_ICONS.ISS;

  function iconImg(file, width, height, cls) {
    return '<img src="' + ICON_DIR + file + '" width="' + width + '" height="' + height + '" alt=""' +
           (cls ? ' class="' + cls + '"' : '') + '>';
  }

  // Кнопка "Домой" - возврат к обзорному виду (как при первом открытии карты).
  // Оформлена как стандартная кнопка MapLibre и стоит под кнопками масштаба
  function HomeControl(onClick) { this._onClick = onClick; }
  HomeControl.prototype.onAdd = function () {
    var c = document.createElement('div');
    c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'isw-home';
    b.title = 'Обзорный вид (как при открытии карты)';
    b.setAttribute('aria-label', b.title);
    b.innerHTML = iconImg('home.svg', 18, 18);
    b.addEventListener('click', this._onClick);
    c.appendChild(b);
    this._container = c;
    return c;
  };
  HomeControl.prototype.onRemove = function () { this._container.remove(); };

  // ---------------------------------------------------------------- Виджет

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGL2RenderingContext && c.getContext('webgl2')) ||
             !!(window.WebGLRenderingContext && c.getContext('webgl'));
    } catch (e) { return false; }
  }

  function showMessage(root, html) {
    var m = document.createElement('div');
    m.className = 'isw-msg';
    m.innerHTML = html;
    root.appendChild(m);
  }

  function initWidget(root) {
    root.classList.add('isw');
    root.innerHTML =
      '<div class="isw-map"></div>' +
      '<div class="isw-panel">' +
      '  <div class="isw-head">' +
      '    <span class="isw-seg isw-sats"></span>' +
      '    <span class="isw-title"></span>' +
      '    <button class="isw-toggle" type="button" title="Свернуть / развернуть панель">&#9650;</button>' +
      '  </div>' +
      '  <div class="isw-body">' +
      '    <div class="isw-row"><span class="isw-k">Время UTC</span><span class="isw-v" data-f="time"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Широта</span><span class="isw-v" data-f="lat"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Долгота</span><span class="isw-v" data-f="lon"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Высота</span><span class="isw-v" data-f="alt"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Скорость</span><span class="isw-v" data-f="speed"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Зенитный угол Солнца</span><span class="isw-v" data-f="sza"></span></div>' +
      '    <hr class="isw-sep">' +
      '    <div class="isw-row"><span class="isw-k">Наклонение</span><span class="isw-v" data-f="incl"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Период</span><span class="isw-v" data-f="period"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Зона видимости</span><span class="isw-v" data-f="ring"></span></div>' +
      '    <div class="isw-row"><span class="isw-k">Эпоха TLE</span><span class="isw-v" data-f="epoch"></span></div>' +
      '    <div class="isw-legend">' +
      '      <span><i class="isw-lg-line"></i>трасса вперед</span> &nbsp;' +
      '      <span><i class="isw-lg-line isw-lg-dash"></i>пройденный виток</span><br>' +
      '      <span><i class="isw-lg-ring"></i>зона радиовидимости</span> &nbsp;' +
      '      <span><i class="isw-lg-night"></i>ночь</span>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="isw-tools">' +
      '  <span class="isw-seg isw-base"></span>' +
      '  <span class="isw-seg isw-proj"></span>' +
      '  <span class="isw-seg isw-follow"></span>' +
      '</div>';

    if (typeof maplibregl === 'undefined' || typeof satellite === 'undefined') {
      showMessage(root, 'Не удалось загрузить библиотеки виджета.');
      return;
    }
    if (!hasWebGL()) {
      showMessage(root, 'Для показа карты нужен браузер с поддержкой WebGL.<br>Обновите браузер или включите аппаратное ускорение.');
      return;
    }

    fetch(BASE_URL + 'tle.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) { startWidget(root, data); })
      .catch(function () { showMessage(root, 'Не удалось загрузить параметры орбит (TLE).'); });
  }

  function startWidget(root, data) {
    var sats = data.satellites.map(makeSat);
    var state = { sat: sats[0], base: 'osm', globe: false, follow: true, lastSlow: 0 };
    var panel = root.querySelector('.isw-panel');
    var fields = {};
    Array.prototype.forEach.call(root.querySelectorAll('[data-f]'), function (el) { fields[el.getAttribute('data-f')] = el; });

    // --- карта
    var sources = {}, layers = [];
    Object.keys(BASEMAPS).forEach(function (id) {
      var b = BASEMAPS[id];
      sources[id] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
      layers.push({ id: id, type: 'raster', source: id, layout: { visibility: id === state.base ? 'visible' : 'none' } });
    });

    var mapEl = root.querySelector('.isw-map');

    // Обзорный масштаб: на плоской карте мир по ширине окна, на глобусе - глобус целиком
    function overviewZoom() {
      if (state.globe) return 1.2;
      var w = mapEl.clientWidth || root.clientWidth || 800;
      return Math.max(0.3, Math.log(w / 512) / Math.LN2);
    }

    var map = new maplibregl.Map({
      container: mapEl,
      style: { version: 8, sources: sources, layers: layers },
      center: [0, 20],
      zoom: overviewZoom(),
      minZoom: 0,
      maxZoom: 12,
      attributionControl: { compact: true },
      locale: MAP_LOCALE,
      dragRotate: false,
      pitchWithRotate: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new HomeControl(function () { goHome(); }), 'top-right');
    map.addControl(new maplibregl.FullscreenControl({ container: root }), 'top-right');

    // "Домой": обзорный масштаб, КА в центре, слежение включено
    function goHome() {
      state.follow = true;
      renderButtons();
      var s = satState(state.sat, new Date());
      map.easeTo({ center: s ? [s.lon, s.lat] : [0, 20], zoom: overviewZoom(), bearing: 0, pitch: 0, duration: 1000 });
    }

    // --- значки КА и Солнца
    var satEl = document.createElement('div');
    satEl.className = 'isw-sat';
    // Значок - в квадратной рамке по большей стороне, чтобы при повороте не наезжать на подпись
    satEl.innerHTML = '<div class="isw-sat-box"><img class="isw-sat-icon" alt=""></div><span class="isw-sat-label"></span>';
    // anchor "top" + сдвиг вверх на половину рамки: точное положение КА - в центре значка
    var satMarker = new maplibregl.Marker({ element: satEl, anchor: 'top' }).setLngLat([0, 0]);
    var sunEl = document.createElement('div');
    sunEl.className = 'isw-sun';
    sunEl.innerHTML = iconImg('sun.svg', 26, 26);
    var sunMarker = new maplibregl.Marker({ element: sunEl }).setLngLat([0, 0]);

    // --- кнопки
    function segButtons(container, items, isOn, onClick) {
      container.innerHTML = '';
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.label;
        if (it.title) b.title = it.title;
        b.className = isOn(it.value) ? 'isw-on' : '';
        b.addEventListener('click', function () { onClick(it.value); });
        container.appendChild(b);
      });
    }

    function renderButtons() {
      segButtons(root.querySelector('.isw-sats'),
        sats.map(function (s) { return { label: s.name, value: s.id, title: 'Показать ' + s.name }; }),
        function (v) { return v === state.sat.id; },
        function (v) { selectSat(v); });
      segButtons(root.querySelector('.isw-base'),
        Object.keys(BASEMAPS).map(function (id) {
          return { label: BASEMAPS[id].label, value: id, title: 'Подложка: ' + BASEMAPS[id].label };
        }),
        function (v) { return v === state.base; },
        function (v) { setBase(v); });
      segButtons(root.querySelector('.isw-proj'),
        [{ label: 'Карта 2D', value: false, title: 'Плоская карта (Веб-Меркатор)' },
         { label: 'Глобус', value: true, title: 'Вид на глобусе' }],
        function (v) { return v === state.globe; },
        function (v) { setGlobe(v); });
      segButtons(root.querySelector('.isw-follow'),
        [{ label: 'Следить за КА', value: true, title: 'Держать КА в центре карты' }],
        function () { return state.follow; },
        function () { state.follow = !state.follow; renderButtons(); if (state.follow) tick(true); });
    }

    root.querySelector('.isw-toggle').addEventListener('click', function () {
      var c = panel.classList.toggle('isw-collapsed');
      this.innerHTML = c ? '&#9660;' : '&#9650;';
    });

    // Пользователь сдвинул карту - перестаем следить за КА
    map.on('dragstart', function () {
      if (state.follow) { state.follow = false; renderButtons(); }
    });

    // Поворот значка КА по направлению полета.
    // Направление берется на экране: проецируем текущую точку и точку через 5 с вперед -
    // так поворот верен и на плоской карте, и на глобусе при любом его положении.
    // У значков "вперед" - это верх рисунка (у МКС ферма перпендикулярна направлению полета)
    var heading = { now: null, ahead: null };

    function updateHeading() {
      if (!heading.now || !heading.ahead) return;
      var lon2 = heading.now[0] + normLon(heading.ahead[0] - heading.now[0]); // без скачка на ±180°
      var p1 = map.project(heading.now), p2 = map.project([lon2, heading.ahead[1]]);
      var dx = p2.x - p1.x, dy = p2.y - p1.y;
      if (dx * dx + dy * dy < 1e-6) return;
      var angle = Math.atan2(dx, -dy) / DEG;                      // по часовой стрелке от "вверх"
      satEl.querySelector('.isw-sat-icon').style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';
    }

    map.on('move', updateHeading);

    function palette() { return BASEMAPS[state.base].imagery ? COLORS.imagery : COLORS.map; }

    function applyColors() {
      var p = palette();
      map.setPaintProperty('night', 'fill-opacity', p.night);
      map.setPaintProperty('track-future', 'line-color', p.track);
      map.setPaintProperty('track-past', 'line-color', p.track);
      map.setPaintProperty('ring-line', 'line-color', p.ring);
      map.setPaintProperty('ring-fill', 'fill-color', p.ring);
    }

    function setBase(id) {
      Object.keys(BASEMAPS).forEach(function (k) { map.setLayoutProperty(k, 'visibility', k === id ? 'visible' : 'none'); });
      state.base = id;
      applyColors();
      renderButtons();
    }

    function setGlobe(on) {
      state.globe = on;
      map.setProjection({ type: on ? 'globe' : 'mercator' });
      if (on && map.getZoom() > 2.5) map.easeTo({ zoom: 1.5 });
      renderButtons();
    }

    function selectSat(id) {
      state.sat = sats.filter(function (s) { return s.id === id; })[0];
      state.follow = true;
      renderButtons();
      tick(true);
    }

    // --- обновление данных на карте
    function setData(src, data) { map.getSource(src).setData(data); }

    // Граница дня и ночи движется медленно - ее достаточно пересчитывать раз в 30 с
    function updateSlow(now) {
      setData('night', nightPolygon(sunPosition(now)));
    }

    // Трасса пересчитывается каждую секунду, чтобы граница между пройденной (пунктир)
    // и будущей (сплошная линия) частями всегда проходила ровно под значком КА
    function updateTrack(now) {
      var sat = state.sat, P = sat.periodMin * 60000;
      var past = trackPoints(sat, new Date(now.getTime() - TRACK_PAST_ORBITS * P), now);
      var future = trackPoints(sat, now, new Date(now.getTime() + TRACK_FUTURE_ORBITS * P));
      setData('track-past', multiLine(splitAtAntimeridian(past)));
      setData('track-future', multiLine(splitAtAntimeridian(future)));
    }

    function updatePanel(now, s, sun) {
      var sat = state.sat;
      var sza = sunZenith(sun, s.lat, s.lon);
      var cls = sza < 90 ? 'isw-day' : (sza < 108 ? 'isw-twilight' : 'isw-night');
      var txt = sza < 90 ? 'день' : (sza < 108 ? 'сумерки' : 'ночь');
      root.querySelector('.isw-title').textContent = sat.name + ' сейчас';
      satEl.querySelector('.isw-sat-label').textContent = sat.name;
      // Значок выбранного КА (меняем только при смене КА, чтобы не перезагружать картинку каждую секунду)
      var icon = SAT_ICONS[sat.id] || DEFAULT_SAT_ICON;
      var img = satEl.querySelector('.isw-sat-icon');
      if (img.getAttribute('data-file') !== icon.file) {
        img.setAttribute('data-file', icon.file);
        img.src = ICON_DIR + icon.file;
        img.width = icon.width;
        img.height = icon.height;
        var box = Math.max(icon.width, icon.height);
        var boxEl = satEl.querySelector('.isw-sat-box');
        boxEl.style.width = boxEl.style.height = box + 'px';
        satMarker.setOffset([0, -box / 2]);
      }
      fields.time.textContent = fmtTime(now) + ' (МСК ' + fmtTime(now, 3) + ')';
      fields.lat.textContent = fmtLat(s.lat);
      fields.lon.textContent = fmtLon(s.lon);
      fields.alt.textContent = fmtNum(s.alt, 1) + ' км';
      fields.speed.textContent = fmtNum(s.speed, 2) + ' км/с (' + fmtInt(s.speed * 3600) + ' км/ч)';
      fields.sza.innerHTML = fmtNum(sza, 1) + '° — <span class="' + cls + '">' + txt + '</span>';
      fields.incl.textContent = fmtNum(sat.inclination, 2) + '°';
      fields.period.textContent = fmtNum(sat.periodMin, 1) + ' мин';
      fields.epoch.textContent = fmtDate(sat.epoch) + ' ' + fmtTime(sat.epoch).slice(0, 5) +
                                 ' UTC (' + fmtAge(now - sat.epoch) + ')';
    }

    function tick(force) {
      var now = new Date();
      var s = satState(state.sat, now);
      if (!s) return;
      var sun = sunPosition(now);
      if (force || now - state.lastSlow > SLOW_UPDATE_SEC * 1000) {
        updateSlow(now);
        state.lastSlow = now.getTime();
      }
      updateTrack(now);
      var fp = footprint(s);
      setData('ring-line', fp.line);
      setData('ring-fill', fp.fill || emptyFC());
      fields.ring.textContent = 'радиус ' + fmtInt(fp.radiusKm) + ' км';
      satMarker.setLngLat([s.lon, s.lat]);
      var a = satState(state.sat, new Date(now.getTime() + 5000));
      heading.now = [s.lon, s.lat];
      heading.ahead = a ? [a.lon, a.lat] : null;
      updateHeading();
      sunMarker.setLngLat([sun.lon, sun.dec]);
      updatePanel(now, s, sun);
      if (state.follow) {
        if (force) map.easeTo({ center: [s.lon, s.lat], duration: 800 });
        else if (!map.isEasing()) map.setCenter([s.lon, s.lat]); // не прерываем плавный переход
      }
    }

    map.on('load', function () {
      var p = palette();
      // Полупрозрачные заливки (ночь, зона видимости) нарезаются только на один, самый общий
      // уровень тайлов (maxzoom: 0). Иначе на глобусе при вращении и масштабировании тайлы
      // разных уровней временно перекрываются, и тень в этих секторах рисуется дважды (темнее)
      ['night', 'ring-fill'].forEach(function (id) {
        map.addSource(id, { type: 'geojson', data: emptyFC(), maxzoom: 0, tolerance: 0, buffer: 0 });
      });
      ['track-past', 'track-future', 'ring-line'].forEach(function (id) {
        map.addSource(id, { type: 'geojson', data: emptyFC() });
      });
      // Контур заливки отключаем: иначе на стыке ±180° виден вертикальный шов
      map.addLayer({ id: 'night', type: 'fill', source: 'night',
                     paint: { 'fill-color': '#000', 'fill-opacity': p.night, 'fill-outline-color': 'rgba(0,0,0,0)' } });
      map.addLayer({ id: 'ring-fill', type: 'fill', source: 'ring-fill',
                     paint: { 'fill-color': p.ring, 'fill-opacity': 0.12, 'fill-outline-color': 'rgba(0,0,0,0)' } });
      map.addLayer({ id: 'ring-line', type: 'line', source: 'ring-line', paint: { 'line-color': p.ring, 'line-width': 1.5 } });
      map.addLayer({ id: 'track-past', type: 'line', source: 'track-past',
                     paint: { 'line-color': p.track, 'line-width': 1.6, 'line-dasharray': [3, 3], 'line-opacity': 0.8 } });
      map.addLayer({ id: 'track-future', type: 'line', source: 'track-future',
                     paint: { 'line-color': p.track, 'line-width': 2.2 } });
      sunMarker.addTo(map);
      satMarker.addTo(map);
      renderButtons();
      tick(true);
      setInterval(function () { tick(false); }, 1000);
    });
  }

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('.iss-widget'), initWidget);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
