import { execFileSync } from 'node:child_process'
import { floatingTagForRelease } from '../src/major-tag.ts'

const listed = execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
const tags = listed
  .split('\n')
  .map((tag) => tag.trim())
  .filter((tag) => tag.length > 0)

const major = floatingTagForRelease(tags)
if (!major) {
  console.log('HEAD has no stable 1.x.y release tag. v1 was not moved.')
  process.exit(0)
}

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.log(`Would move ${major} to HEAD (${tags.join(', ')}). Not pushing outside GitHub Actions.`)
  process.exit(0)
}

execFileSync('git', ['tag', '-f', major])
execFileSync('git', ['push', 'origin', `refs/tags/${major}:refs/tags/${major}`, '--force'])
console.log(`Moved ${major} to HEAD.`)
