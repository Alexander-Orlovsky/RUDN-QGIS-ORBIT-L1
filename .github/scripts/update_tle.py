"""
Обновление TLE для виджета "МКС и TERRA сейчас" (assets/iss-widget/tle.json).

Запускается заданием GitHub Actions (.github/workflows/update-tle.yml) раз в сутки,
можно запустить и вручную: python .github/scripts/update_tle.py

Берет свежие TLE с CelesTrak (регистрация не нужна), проверяет их и обновляет tle.json.
Только стандартная библиотека Python - ничего устанавливать не нужно.
Код возврата 1 - если хотя бы для одного КА TLE получить или проверить не удалось
(остальные КА при этом все равно обновляются).
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# tle.json лежит в assets/iss-widget/ относительно корня репозитория
TLE_FILE = Path(__file__).resolve().parents[2] / 'assets' / 'iss-widget' / 'tle.json'
CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=TLE'
USER_AGENT = 'RUDN-QGIS-ORBIT-L1 TLE updater (GitHub Actions, once a day)'

# Повторные попытки при сетевых сбоях (CelesTrak иногда не отвечает серверам GitHub - 31.10.2026
# не ответил 2 мин подряд). Повторяем только таймауты и ошибки соединения: на ответ сервера
# с HTTP-ошибкой (например, 403 при слишком частых запросах) повтор не поможет.
FETCH_ATTEMPTS = 3       # всего попыток на один КА
FETCH_TIMEOUT = 30       # ожидание ответа, с
RETRY_PAUSE = 60         # пауза между попытками, с


def checksum_ok(line):
    """Контрольная сумма строки TLE: сумма цифр + 1 за каждый минус, по модулю 10 (колонка 69)."""
    total = sum(int(c) if c.isdigit() else (1 if c == '-' else 0) for c in line[:68])
    return total % 10 == int(line[68])


def tle_epoch(line1):
    """Эпоха TLE: колонки 19-32 первой строки, формат ГГДДД.ДДДДДДДД."""
    yy = int(line1[18:20])
    year = 2000 + yy if yy < 57 else 1900 + yy
    day_of_year = float(line1[20:32])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1)


def download(url):
    """Загрузка текста по url с повторными попытками при таймаутах и ошибках соединения."""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                return resp.read().decode('ascii', errors='replace')
        except urllib.error.HTTPError:
            raise   # сервер ответил ошибкой - не повторяем
        except (urllib.error.URLError, OSError) as exc:   # таймаут, обрыв, DNS
            if attempt == FETCH_ATTEMPTS:
                raise
            print('  попытка %d из %d не удалась (%s), повтор через %d с'
                  % (attempt, FETCH_ATTEMPTS, exc, RETRY_PAUSE))
            time.sleep(RETRY_PAUSE)


def fetch_tle(norad):
    """Получение и проверка TLE одного КА. Возвращает (строка1, строка2) или вызывает исключение."""
    text = download(CELESTRAK_URL.format(norad=norad))
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    line1 = next((ln for ln in lines if ln.startswith('1 ')), None)
    line2 = next((ln for ln in lines if ln.startswith('2 ')), None)
    if not line1 or not line2:
        raise ValueError('в ответе CelesTrak нет строк TLE: ' + text[:200].replace('\n', ' | '))
    for ln in (line1, line2):
        if len(ln) != 69:
            raise ValueError('неверная длина строки TLE (%d вместо 69): %s' % (len(ln), ln))
        if not checksum_ok(ln):
            raise ValueError('неверная контрольная сумма строки TLE: ' + ln)
        if int(ln[2:7]) != norad:
            raise ValueError('номер NORAD в TLE (%s) не совпадает с запрошенным (%d)' % (ln[2:7], norad))
    return line1, line2


def main():
    data = json.loads(TLE_FILE.read_text(encoding='utf-8'))
    changed = False
    errors = 0

    for sat in data['satellites']:
        name, norad = sat['id'], int(sat['norad'])
        try:
            line1, line2 = fetch_tle(norad)
        except Exception as exc:
            print('ОШИБКА %s (%d): %s' % (name, norad, exc))
            errors += 1
            continue

        new_epoch, old_epoch = tle_epoch(line1), tle_epoch(sat['line1'])
        if new_epoch < old_epoch:
            print('%s: полученный TLE старее имеющегося (%s < %s) - оставлен прежний' % (name, new_epoch, old_epoch))
            continue
        if line1 == sat['line1'] and line2 == sat['line2']:
            print('%s: TLE не изменились (эпоха %s UTC)' % (name, old_epoch.strftime('%Y-%m-%d %H:%M')))
            continue

        sat['line1'], sat['line2'] = line1, line2
        changed = True
        print('%s: TLE обновлены, эпоха %s UTC (была %s UTC)'
              % (name, new_epoch.strftime('%Y-%m-%d %H:%M'), old_epoch.strftime('%Y-%m-%d %H:%M')))

    if changed:
        data['updated_utc'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        TLE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
        print('Файл %s обновлен' % TLE_FILE.name)
    else:
        print('Изменений нет - файл не перезаписан')

    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
