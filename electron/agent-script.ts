// 원격 서버에 업로드해 실행하는 수집 에이전트(bash).
//  - 추가 패키지 불필요: /proc, ps, df 등 기본 도구만 사용
//  - 모드: once(1회 출력) / daemon(상시 수집·파일 기록) / stop(데몬 종료)
//  - daemon 은 metrics.jsonl 에 JSON 한 줄씩 append, PID 파일로 중복 실행 차단,
//    파일은 MAX_LINES 로 자동 트림하여 무한 증가 방지.
//
// 패키징(asar/Windows 경로) 함정을 피하려고 .sh 파일 대신 문자열로 임베드한다.
// 주의: String.raw 라도 bash 의 ${1:-x} 같은 ${...} 는 JS 보간으로 깨지므로 사용 금지.
// 버전 변경 시 AGENT_VERSION 을 올리면 배포 로직에서 강제 재업로드에 활용 가능.

export const AGENT_VERSION = 7

export const AGENT_SCRIPT = String.raw`#!/usr/bin/env bash
export LC_ALL=C
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="$DIR/metrics.jsonl"
PIDF="$DIR/agent.pid"
MAX_LINES=720          # 5초 간격 x 720 ~= 1시간 보관

snapshot(){
  # CPU + 네트워크 동시 샘플링 (0.3초 윈도우 공유)
  read t1 i1 < <(awk '/^cpu /{idle=$5+$6;t=0;for(i=2;i<=NF;i++)t+=$i;print t,idle}' /proc/stat)
  read rx1 tx1 < <(awk 'NR>2 && $1!="lo:"{rx+=$2;tx+=$10}END{printf "%d %d",rx+0,tx+0}' /proc/net/dev)
  sleep 0.3
  read t2 i2 < <(awk '/^cpu /{idle=$5+$6;t=0;for(i=2;i<=NF;i++)t+=$i;print t,idle}' /proc/stat)
  read rx2 tx2 < <(awk 'NR>2 && $1!="lo:"{rx+=$2;tx+=$10}END{printf "%d %d",rx+0,tx+0}' /proc/net/dev)
  dt=$((t2-t1)); di=$((i2-i1)); cpu=0
  [ "$dt" -gt 0 ] && cpu=$(awk -v t=$dt -v i=$di 'BEGIN{printf "%.1f",(t-i)/t*100}')
  rxmbs=$(awk -v r1=$rx1 -v r2=$rx2 'BEGIN{d=r2-r1;printf "%.2f",(d<0?0:d)/0.3/1048576}')
  txmbs=$(awk -v t1=$tx1 -v t2=$tx2 'BEGIN{d=t2-t1;printf "%.2f",(d<0?0:d)/0.3/1048576}')

  # 메모리(MB) / 디스크(루트 /, GB)
  read mt mu ma mp < <(awk '/^MemTotal:/{T=$2}/^MemAvailable:/{A=$2}
    END{u=T-A;printf "%.0f %.0f %.0f %.1f",T/1024,u/1024,A/1024,(T>0?u/T*100:0)}' /proc/meminfo)
  read dkt dku dkp < <(df -P / | awk 'NR==2{gsub("%","",$5);printf "%.1f %.1f %s",$2/1048576,$3/1048576,$5}')

  read l1 l5 l15 _ < /proc/loadavg
  up=$(awk '{printf "%d",$1}' /proc/uptime)
  hn=$(hostname 2>/dev/null || echo unknown)

  # 상위 프로세스(CPU 기준 5개) -> JSON 배열 (이름의 큰따옴표/백슬래시 이스케이프)
  procs=$(ps -eo pid=,comm=,%cpu=,%mem= --sort=-%cpu 2>/dev/null | head -n 10 | awk '
    BEGIN{printf "["}
    { n=$2; gsub(/\\/,"\\\\",n); gsub(/"/,"\\\"",n);
      printf "%s{\"pid\":%d,\"name\":\"%s\",\"cpu\":%.1f,\"mem\":%.1f}",(NR>1?",":""),$1,n,$3,$4 }
    END{printf "]"}')

  # failed 상태 systemd 서비스 목록 (systemctl 없으면 빈 배열)
  # $1이 ● 불릿이거나 빈 줄인 경우를 대비해 unit suffix(.service 등) 필드를 탐색
  svcfailed=$(systemctl list-units --state=failed --no-legend --no-pager 2>/dev/null \
    | awk 'NF>0{for(i=1;i<=NF;i++){if($i~/\.(service|socket|target|mount|timer|path|scope|slice|device)$/){n=$i;gsub(/\\/,"\\\\",n);gsub(/"/,"\\\"",n);printf "%s\"%s\"",(c++?",":""),n;break}}}')

  # 전체 디스크 마운트 포인트 (/dev/* 실제 블록 디바이스만)
  disks=$(df -P 2>/dev/null \
    | awk '$1~/^\/dev\// && $2+0>0{mp=$6;gsub(/\\/,"\\\\",mp);gsub(/"/,"\\\"",mp);printf "%s{\"mount\":\"%s\",\"total\":%.1f,\"used\":%.1f,\"pct\":%d}",(c++?",":""),mp,$2/1048576,$3/1048576,$5+0}')

  printf '{"ts":%s,"host":"%s","uptime":%s,"cpu":%s,"load":[%s,%s,%s],"mem":{"total":%s,"used":%s,"avail":%s,"pct":%s},"disk":{"total":%s,"used":%s,"pct":%s},"procs":%s,"net":{"rxMBs":%s,"txMBs":%s},"svcFailed":[%s],"disks":[%s]}\n' \
    "$(date +%s)" "$hn" "$up" "$cpu" "$l1" "$l5" "$l15" "$mt" "$mu" "$ma" "$mp" "$dkt" "$dku" "$dkp" "$procs" "$rxmbs" "$txmbs" "$svcfailed" "$disks"
}

mode="$1"; [ -z "$mode" ] && mode=once
case "$mode" in
  once)
    snapshot
    ;;
  daemon)
    interval="$2"; [ -z "$interval" ] && interval=5
    # 이미 살아있는 데몬이 있으면 중복 실행하지 않음
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
      echo "already-running"; exit 0
    fi
    echo $$ > "$PIDF"
    trap 'rm -f "$PIDF"; exit 0' TERM INT
    while true; do
      snapshot >> "$DATA" 2>/dev/null
      lines=$(wc -l < "$DATA" 2>/dev/null || echo 0)
      if [ "$lines" -gt "$MAX_LINES" ]; then
        tail -n "$MAX_LINES" "$DATA" > "$DATA.tmp" 2>/dev/null && mv "$DATA.tmp" "$DATA"
      fi
      sleep "$interval"
    done
    ;;
  stop)
    [ -f "$PIDF" ] && kill "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null
    rm -f "$PIDF"
    ;;
esac
`
