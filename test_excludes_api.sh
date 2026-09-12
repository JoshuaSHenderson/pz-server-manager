#!/usr/bin/env bash
# Local integration check for the exclusion path. Builds a fake /pz-data + /workshop that
# reproduces the live Marz layout (two folders in one Workshop item declaring the same mod id),
# plus a second item that shares a folder name with a third, and drives the real HTTP API.
set -u

ROOT=/s
DATA=$ROOT/pz-data
WS=$ROOT/workshop/content/108600
PORT=7777
BASE=http://127.0.0.1:$PORT

rm -rf "$DATA" "$ROOT/workshop"
mkdir -p "$DATA/Server" "$DATA/mods" "$DATA/db"

mkmod() { # item folder modid
  mkdir -p "$WS/$1/mods/$2/42"
  printf 'name=%s\nid=%s\n' "$2" "$3" > "$WS/$1/mods/$2/42/mod.info"
  cp -r "$WS/$1/mods/$2" "$DATA/mods/$2"
}

# Item 3722134990: two folders, one mod id — the live collision.
mkmod 3722134990 GunsOfMarz               MarzGuns
mkmod 3722134990 GunsOfMarzPreviousVersion MarzGuns
# Item 3774316897: the separate Linux animsets mod, no collision.
mkmod 3774316897 linux_animsets_marz_mods_redux Linux_Animsets_Marz_Mods
# Items 111 and 222 both ship a folder called Shared — the <data>/mods guard.
mkmod 111 Shared SharedModA
mkmod 222 Shared SharedModA

cat > "$DATA/Server/servertest.ini" <<INI
RCONPassword=test
RCONPort=27015
Mods=MarzGuns;Linux_Animsets_Marz_Mods;SharedModA
WorkshopItems=3722134990;3774316897;111;222
INI

node server.js > /tmp/itest.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf "$BASE/api/servers" >/dev/null 2>&1 && break; sleep 0.25; done

fail=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected [$2] got [$3]"; fail=1; fi
}

echo "== duplicate detection =="
DUP=$(curl -s "$BASE/api/mods/excludes")
check "two duplicate ids reported" "2" "$(echo "$DUP" | grep -o '"modId":' | wc -l | tr -d ' ')"
check "it is MarzGuns" "1" "$(echo "$DUP" | grep -c '"modId":"MarzGuns"')"

echo "== the guard: excluding the only provider of an enabled id is refused =="
CODE=$(curl -s -o /tmp/r1.json -w '%{http_code}' -X POST "$BASE/api/mods/excludes" \
  -H 'Content-Type: application/json' -d '{"workshopId":"3774316897","folder":"linux_animsets_marz_mods_redux"}')
check "refused with 409" "409" "$CODE"
check "names the orphaned id" "1" "$(grep -c 'Linux_Animsets_Marz_Mods' /tmp/r1.json)"
check "files untouched" "1" "$([ -d "$DATA/mods/linux_animsets_marz_mods_redux" ] && echo 1 || echo 0)"

echo "== excluding one of two folders sharing a mod id is allowed =="
CODE=$(curl -s -o /tmp/r2.json -w '%{http_code}' -X POST "$BASE/api/mods/excludes" \
  -H 'Content-Type: application/json' -d '{"workshopId":"3722134990","folder":"GunsOfMarzPreviousVersion"}')
check "accepted" "200" "$CODE"
check "workshop copy gone" "0" "$([ -d "$WS/3722134990/mods/GunsOfMarzPreviousVersion" ] && echo 1 || echo 0)"
check "mods copy gone" "0" "$([ -d "$DATA/mods/GunsOfMarzPreviousVersion" ] && echo 1 || echo 0)"
check "the kept folder survives" "1" "$([ -d "$DATA/mods/GunsOfMarz" ] && echo 1 || echo 0)"
check "Mods= untouched" "Mods=MarzGuns;Linux_Animsets_Marz_Mods;SharedModA" "$(grep '^Mods=' "$DATA/Server/servertest.ini")"
check "WorkshopItems= untouched" "WorkshopItems=3722134990;3774316897;111;222" "$(grep '^WorkshopItems=' "$DATA/Server/servertest.ini")"
check "duplicate no longer reported" "0" "$(curl -s "$BASE/api/mods/excludes" | grep -c '"modId":"MarzGuns"')"

echo "== the shared-folder guard: <data>/mods/Shared is left alone =="
CODE=$(curl -s -o /tmp/r3.json -w '%{http_code}' -X POST "$BASE/api/mods/excludes" \
  -H 'Content-Type: application/json' -d '{"workshopId":"111","folder":"Shared","force":true}')
check "accepted" "200" "$CODE"
check "item 111 copy gone" "0" "$([ -d "$WS/111/mods/Shared" ] && echo 1 || echo 0)"
check "item 222 copy kept" "1" "$([ -d "$WS/222/mods/Shared" ] && echo 1 || echo 0)"
check "shared <data>/mods copy kept" "1" "$([ -d "$DATA/mods/Shared" ] && echo 1 || echo 0)"

echo "== exclusions are reapplied, not one-shot =="
mkdir -p "$WS/3722134990/mods/GunsOfMarzPreviousVersion/42"
printf 'name=x\nid=MarzGuns\n' > "$WS/3722134990/mods/GunsOfMarzPreviousVersion/42/mod.info"
cp -r "$WS/3722134990/mods/GunsOfMarzPreviousVersion" "$DATA/mods/GunsOfMarzPreviousVersion"
curl -s -X POST "$BASE/api/server/start" >/dev/null   # bringUp() sweeps before docker start
sleep 1
check "re-shipped folder swept on start" "0" "$([ -d "$WS/3722134990/mods/GunsOfMarzPreviousVersion" ] && echo 1 || echo 0)"

echo "== reinstall refuses without the install mount =="
CODE=$(curl -s -o /tmp/r4.json -w '%{http_code}' -X POST "$BASE/api/mods/3722134990/reinstall")
check "refused with 409" "409" "$CODE"
check "explains the missing mount" "1" "$(grep -c 'pz-install' /tmp/r4.json)"

echo "== path traversal is rejected =="
check "bad folder" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/mods/excludes" -H 'Content-Type: application/json' -d '{"workshopId":"111","folder":"../../etc"}')"
check "bad workshop id" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/mods/notanid")"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
