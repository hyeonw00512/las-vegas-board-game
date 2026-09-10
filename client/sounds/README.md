# 라스베가스 사운드 파일

이 폴더에 MP3 파일을 넣으면 게임이 자동으로 인식합니다. 파일이 없거나 재생할 수 없으면 해당 효과만 기본 전자음으로 재생되므로, 사운드 파일을 모두 준비할 때까지도 게임은 정상 작동합니다.

## 파일 이름

| 파일명 | 길이 권장 | 용도 |
| --- | ---: | --- |
| `dice-roll.mp3` | 0.3~1.2초 | 주사위 굴림 |
| `dice-place.mp3` | 0.2~0.8초 | 주사위 배치 |
| `neutral-place.mp3` | 0.3~1.0초 | 중립 주사위 자동 배치 |
| `round-result.mp3` | 0.8~2.0초 | 라운드 정산 |
| `next-round.mp3` | 0.4~1.2초 | 다음 라운드·재시작 |
| `victory.mp3` | 1.0~3.0초 | 최종 승리 |
| `your-turn.mp3` | 0.8~2.0초 | 내 차례 음성 안내 |

## Azure 음성 안내 만들기

1. Azure Speech Studio의 **Audio Content Creation**에서 한국어 음성을 선택합니다.
2. 문구를 `현님, 지금 차례입니다.` 또는 `내 차례입니다. 주사위를 굴려주세요.`처럼 짧게 입력합니다.
3. 미리 듣기로 확인한 뒤 MP3로 내보냅니다.
4. 파일명을 `your-turn.mp3`로 바꾸어 이 폴더에 넣습니다.

Azure Speech는 텍스트를 합성 음성으로 바꾸며, Speech Studio에서 코드 없이 생성할 수 있습니다. 브라우저에서 Azure API를 직접 호출하지 말고, 생성된 파일만 이 폴더에 저장하세요. 그러면 Azure 키가 공개되지 않습니다.

## 무료 효과음 사용 전 확인

- Pixabay 음원은 무료 사용·수정이 가능하지만, 파일 자체를 그대로 재배포할 수는 없습니다. 게임 안에서 효과음으로 사용하는 것은 보통 "창작물 안의 사용"에 해당하더라도, 각 음원의 표기와 추가 권리 여부를 확인하세요.
- Freesound는 파일마다 라이선스가 다를 수 있습니다. `CC0` 또는 상업적 사용이 가능한 라이선스를 우선 고르고, `CC BY`라면 아래 크레딧 파일에 출처를 기록하세요.
- 유명 카지노·슬롯머신 게임의 효과음이나 상업 음원을 무단으로 사용하지 마세요.

## 크레딧 기록 예시

출처 표기가 필요하면 이 폴더에 `CREDITS.md`를 추가해 다음처럼 남깁니다.

```md
- dice-roll.mp3 — 제작자 이름, 원본 페이지 주소, CC BY 4.0
```

공식 참고 문서:

- Azure Speech Text to Speech: <https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech>
- Pixabay Content License: <https://pixabay.com/service/license-summary/>
- Freesound License FAQ: <https://freesound.org/help/faq/>
