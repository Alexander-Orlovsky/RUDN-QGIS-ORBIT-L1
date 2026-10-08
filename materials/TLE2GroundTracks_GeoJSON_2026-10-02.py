
# Импортируем необходимые библиотеки
from datetime import datetime, date, timedelta, timezone
import spacetrack.operators as op
from spacetrack import SpaceTrackClient
from pyorbital.orbital import Orbital
from pyorbital import astronomy
import numpy as np

# И стандартные модули "json" (для записи GeoJSON), а также "os" (для работы с путями к файлам);
# библиотека "pyshp" для GeoJSON не нужна
import json
import os

# Имя пользователя и пароль (регистрация на https://www.space-track.org)
USERNAME = 'ваш_логин'
PASSWORD = 'ваш_пароль'

# Папка, в которой лежит сам скрипт. Относительные имена выходных файлов
# отсчитываются от нее, а не от текущей рабочей папки, поэтому результат
# сохраняется рядом со скриптом независимо от способа запуска
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


# Получение TLE от Space-Track.
# ИЗМЕНЕНО: классы запросов "tle" и "tle_latest" Space-Track больше не поддерживает,
# вместо них используются "gp_history" (архив) и "gp" (самый свежий набор).
# В текущей версии скрипта эта функция используется только для будущих дат (latest=True);
# для сегодняшней и прошедших дат используется get_spacetrack_tle_nearest (см. ниже).
def get_spacetrack_tle(sat_id, start_date, end_date, username, password, latest=False):
    st = SpaceTrackClient(identity=username, password=password)
    if not latest:
        daterange = op.inclusive_range(start_date, end_date)
        data = st.gp_history(norad_cat_id=sat_id, orderby='epoch desc', limit=1,
                             format='tle', epoch=daterange)
    else:
        data = st.gp(norad_cat_id=sat_id, format='tle')

    # ИЗМЕНЕНО: возвращаем три значения, как ожидает вызывающий код
    if not data:
        return None, None, None

    # ИЗМЕНЕНО: разбор по строкам вместо фиксированных срезов
    lines = [line.strip() for line in data.strip().splitlines() if line.strip()]
    if len(lines) < 2:
        return None, None, None
    tle_1, tle_2 = lines[0], lines[1]

    # Определение "orb_incl" ввел Орловский для извлечения из TLE наклонения орбиты
    # (колонки 9-16 второй строки TLE)
    orb_incl = float(tle_2[8:16])
    return tle_1, tle_2, orb_incl


# Эпоха TLE: колонки 19-32 первой строки, формат ГГДДД.ДДДДДДДД
# (год двумя цифрами и день года с дробной частью)
def tle_epoch(tle_1):
    yy = int(tle_1[18:20])
    year = 2000 + yy if yy < 57 else 1900 + yy
    day_of_year = float(tle_1[20:32])
    return datetime(year, 1, 1) + timedelta(days=day_of_year - 1)


# Получение из архива (gp_history) набора TLE с эпохой, ближайшей к моменту target_time.
# Поиск ведется в окне search_days суток до и после целевой даты, поэтому функция
# работает и для объектов, TLE которых публикуются реже раза в сутки.
def get_spacetrack_tle_nearest(sat_id, target_time, username, password, search_days=3):
    st = SpaceTrackClient(identity=username, password=password)
    # Окно поиска: search_days суток до и после целевой даты
    # (верхняя граница +1 сутки, т.к. дата без времени трактуется как полночь)
    daterange = op.inclusive_range(target_time.date() - timedelta(days=search_days),
                                   target_time.date() + timedelta(days=search_days + 1))
    data = st.gp_history(norad_cat_id=sat_id, orderby='epoch asc',
                         format='tle', epoch=daterange)
    if not data:
        return None, None, None

    lines = [line.strip() for line in data.strip().splitlines() if line.strip()]

    # Перебираем пары строк и ищем набор с эпохой, ближайшей к target_time
    best = None
    for k in range(0, len(lines) - 1, 2):
        l1, l2 = lines[k], lines[k + 1]
        if not (l1.startswith('1 ') and l2.startswith('2 ')):
            continue
        delta = abs((tle_epoch(l1) - target_time).total_seconds())
        if best is None or delta < best[0]:
            best = (delta, l1, l2)

    if best is None:
        return None, None, None
    delta_sec, tle_1, tle_2 = best

    # Сообщаем, насколько эпоха выбранного TLE отстоит от середины суток
    delta_hours = delta_sec / 3600
    print('Эпоха выбранного TLE: ' + str(tle_epoch(tle_1)) + ' UTC'
          + ' (отстоит от середины суток на ' + '{:.1f}'.format(delta_hours) + ' ч)')
    if delta_hours > 36:
        print('ВНИМАНИЕ: за ближайшие к указанной дате сутки TLE не публиковались, '
              'точность расчета может быть снижена')

    # Наклонение орбиты (колонки 9-16 второй строки TLE)
    return tle_1, tle_2, float(tle_2[8:16])


# Формирование одного объекта (Feature) GeoJSON с геометрией "точка" в виде одной строки.
# Координаты в GeoJSON записываются в порядке [долгота, широта]
def geojson_point_feature(lon, lat, properties):
    # Атрибуты: json.dumps дает '{"Point_ID": 0, ...}', внешние фигурные скобки убираем,
    # чтобы оформить строку так же, как это делает QGIS
    props = json.dumps(properties, ensure_ascii=False)[1:-1]
    return ('{ "type": "Feature", "properties": { ' + props + ' }, '
            '"geometry": { "type": "Point", "coordinates": [ '
            + json.dumps(lon) + ', ' + json.dumps(lat) + ' ] } }')


# На вход будем требовать идентификатор спутника, день (в формате date (y,m,d)),
# шаг в минутах для определения положения спутника, путь для результирующего файла
# и (необязательно) ширину окна поиска TLE в сутках - search_days
def create_orbital_track_geojson_for_day(sat_id, track_day, step_minutes, output_geojson,
                                         search_days=3):
    # Если запрошенная дата еще не наступила, архивных TLE за нее нет, поэтому берем
    # самый свежий набор на текущий момент (класс 'gp') и рассчитываем орбиту с упреждением.
    # Точность такого прогноза снижается по мере удаления даты от эпохи TLE.
    if track_day > date.today():
        print('В расчеты взят набор TLE самый последний на текущий момент ('
              + str(datetime.now(timezone.utc)) + ')')
        tle_1, tle_2, orb_incl = get_spacetrack_tle(sat_id, None, None, USERNAME, PASSWORD, True)
    # Иначе (дата сегодняшняя или прошедшая) берем из архива (gp_history) набор TLE
    # с эпохой, ближайшей к середине суток (12:00 UTC)
    else:
        noon = datetime(track_day.year, track_day.month, track_day.day, 12, 0, 0)
        tle_1, tle_2, orb_incl = get_spacetrack_tle_nearest(sat_id, noon, USERNAME, PASSWORD,
                                                            search_days)

    # Если не получилось добыть TLE в окне поиска
    if not tle_1 or not tle_2:
        print('Невозможно извлечь TLE')
        return

    # Создаем экземпляр класса Orbital
    orb = Orbital("N", line1=tle_1, line2=tle_2)

    # Если указано только имя файла (относительный путь), сохраняем его в папку скрипта
    if not os.path.isabs(output_geojson):
        output_geojson = os.path.join(SCRIPT_DIR, output_geojson)
    # Создаем папку для результата, если ее еще нет
    os.makedirs(os.path.dirname(output_geojson), exist_ok=True)

    # Список строк-объектов (Feature) будущего GeoJSON
    features = []

    # Объявляем счетчики, i для идентификаторов, minutes для времени
    i = 0
    minutes = 0

    # Комментарий Орловского - ограничения:
    #  1) расчет производится не более чем на одни сутки (не более 1440 минут, уменьшить можно);
    #  2) первая точка - самое начало суток.
    # Убрать "лишние" (ненужные) точки или витки можно и проще в самом QGIS.
    # Или объединить в QGIS несколько суточных орбит, рассчитанных по отдельности.
    while minutes < 1440:
        utc_hour = int(minutes // 60)
        utc_minutes = int((minutes - (utc_hour * 60)) // 1)
        utc_seconds = int(round((minutes - (utc_hour * 60) - utc_minutes) * 60))

        utc_time = datetime(track_day.year, track_day.month, track_day.day,
                            utc_hour, utc_minutes, utc_seconds)
        utc_string = utc_time.strftime('%Y-%m-%d %H:%M:%S')

        # Положение спутника
        lon, lat, alt = orb.get_lonlatalt(utc_time)
        # Номер витка
        orb_num = orb.get_orbit_number(utc_time, tbus_style=False)
        # Зенитный угол Солнца
        sun_zenith = astronomy.sun_zenith_angle(utc_time, lon, lat)
        # Скорость спутника (км/с)
        pos, vel = orb.get_position(utc_time, normalize=False)
        vel_ = float(np.sqrt(vel[0] ** 2 + vel[1] ** 2 + vel[2] ** 2))

        # Координаты с точностью 6 знаков после запятой (около 10 см)
        lon_r = round(float(lon), 6)
        lat_r = round(float(lat), 6)

    # Создаем в GeoJSON новый объект
        # Определяем атрибуты (значения numpy приводим к обычным типам Python)
        # Для времени используем строку, т.к. в GeoJSON нет отдельного типа "дата и время"
        properties = {
            'Point_ID': i,
            'Orbit_Num': int(orb_num),
            'Date_Time': utc_string,
            'Latitude': lat_r,
            'Longitude': lon_r,
            'Altitude': round(float(alt), 3),
            'Velocity': round(vel_, 5),
            'Sun_Zenith': round(float(sun_zenith), 2),
            'Orbit_Incl': round(float(orb_incl), 4),
        }
        # и геометрию - одна строка файла на одну точку
        features.append(geojson_point_feature(lon_r, lat_r, properties))

        # Не забываем про счетчики
        i += 1
        minutes += step_minutes

    try:
        # Имя слоя - имя файла без расширения (как в GeoJSON, сохраненном из QGIS)
        layer_name = os.path.splitext(os.path.basename(output_geojson))[0]

        # Файл .prj не нужен: по RFC 7946 координаты GeoJSON всегда в WGS84
        # (долгота, широта). Член "crs" с CRS84 записываем так же, как это делает QGIS
        with open(output_geojson, 'w', encoding='utf-8', newline='\n') as f:
            f.write('{\n')
            f.write('"type": "FeatureCollection",\n')
            f.write('"name": ' + json.dumps(layer_name, ensure_ascii=False) + ',\n')
            f.write('"crs": { "type": "name", "properties": '
                    '{ "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n')
            f.write('"features": [\n')
            f.write(',\n'.join(features))
            f.write('\n]\n')
            f.write('}\n')
        print('Файл GeoJSON "' + os.path.normpath(output_geojson) + '" сохранен успешно.')
    except Exception as e:
        # Вдруг нет прав на запись или вроде того...
        print('Не удалось сохранить файл GeoJSON: ' + str(e))
        return


# Необязательный последний параметр search_days (по умолчанию 3) - окно поиска TLE
# в сутках до и после указанной даты; для редко обновляемых объектов его можно увеличить.


# ВНИМАНИЕ: при создании даты date(год, месяц, день) месяц и день,
# меньшие 10, записываются одной цифрой, БЕЗ ВЕДУЩЕГО НУЛЯ:
#   правильно:   date(2026, 9, 6)
#   ошибка:      date(2026, 09, 06)  -> SyntaxError

# ISS (ZARYA) ( NORAD ID 25544 )
create_orbital_track_geojson_for_day(25544, date(2026, 9, 32), 0.5, r'ISS_2026-09-32_30sec.geojson')

# TERRA ( NORAD ID 25994 )
create_orbital_track_geojson_for_day(25994, date(2026, 9, 32), 0.5, r'TERRA_2026-09-32_30sec.geojson')

