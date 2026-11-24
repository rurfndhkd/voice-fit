import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctText, understand, nearestExercise, toJamo } from '../public/js/understand.js';

test('자모 분해', () => {
  assert.deepEqual(toJamo('스쿼트'), ['ㅅ', 'ㅡ', 'ㅋ', 'ㅝ', 'ㅌ', 'ㅡ']);
});

test('자주 틀리게 들리는 운동·명령어를 바로잡는다', () => {
  assert.equal(correctText('스커트 20개 카운트 시작').text, '스쿼트 20개 카운트 시작');
  assert.equal(correctText('스쿼드 20개 세자').text, '스쿼트 20개 세자');
  assert.equal(correctText('푸쉬업 15개 했어').text, '푸시업 15개 했어');
  assert.equal(correctText('플랭그 1분 타이머').text, '플랭크 1분 타이머');
  assert.equal(correctText('벤치 프래스 3세트').text, '벤치프레스 3세트');
  assert.equal(correctText('런지 카운터 시작').text, '런지 카운트 시작');
});

test('발음이 비슷한 단어를 운동 이름으로 (운동 문장일 때만)', () => {
  assert.equal(nearestExercise('런치'), '런지');
  assert.equal(correctText('런치 20개').text, '런지 20개');
  assert.equal(correctText('점핑 잭 30개').text, '점핑잭 30개');
  // 운동 얘기가 아니면 그대로
  assert.equal(correctText('커피 마시고 올게').text, '커피 마시고 올게');
  assert.equal(correctText('런치 먹으러 가').text, '런치 먹으러 가');
});

test('맞는 말·흔한 낱말은 건드리지 않는다', () => {
  for (const s of ['스쿼트 20개 카운트 시작', '다음 세트 시작', '대화 끝', '하나 둘 셋 넷', '오늘 운동 끝', '방금 기록 지워']) {
    assert.equal(correctText(s).text, s, s);
  }
});

test('후보 중 운동으로 말이 되는 문장을 고른다', () => {
  const r = understand('스 커 트 이십 개', ['스쿼트 20개', '스커트 20개']);
  assert.equal(r.text.replace(/\s+/g, ''), '스쿼트이십개');
  // 1순위가 운동 이름 없이 숫자만 있으면, 운동 이름이 있는 후보를 고른다
  assert.equal(understand('20개 카운트', ['스쿼트 20개 카운트']).text, '스쿼트 20개 카운트');
});

test('1순위에 이미 뜻이 분명한 활동(목록 밖 운동 포함)이 있으면 다른 후보로 바꾸지 않는다', () => {
  assert.equal(understand('수영 투 세트', ['스쿼트 2세트']).text, '수영 투 세트');
  assert.equal(understand('러닝 30분', ['런지 30분']).text, '러닝 30분');
});

test('1순위가 끝내는 말이면 후보로 바꾸지 않는다', () => {
  assert.equal(understand('그만할게', ['스쿼트 할게']).text, '그만할게');
});

test('지난 기록의 운동 이름을 우선 알아듣는다', () => {
  const r = understand('케틀밸 스윙 20개', [], { history: ['케틀벨스윙'] });
  assert.equal(r.text, '케틀벨스윙 20개');
});
