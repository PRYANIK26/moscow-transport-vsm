// Old published versions keep their original data. These two generated notices
// are presentation boilerplate, not scenario instructions or action limitations.
export function scenarioDescription(text: string) {
  return text
    .replace(' Баллы и реплики — демонстрационный авторский черновик, не экспертная оценка.', '')
    .replace(' Баллы и реплики — авторский черновик для методического ревью.', '');
}
