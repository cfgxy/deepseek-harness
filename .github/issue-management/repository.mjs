import process from 'node:process'

/**
 * Resolve the repository targeted by the current GitHub Actions run.
 * @param {string|undefined} value Optional owner/repository value for tests.
 * @returns {{organization: string, repository: string, fullName: string}}
 */
export function repositoryContext(value = process.env.GITHUB_REPOSITORY) {
  const match = value?.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/u)
  if (!match) throw new Error('GITHUB_REPOSITORY 必须为 owner/repository')
  return { organization: match[1], repository: match[2], fullName: value }
}
