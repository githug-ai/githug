# githug in GitHub Actions

Use this when an agent runs in a workflow and should push as itself, not as `github-actions[bot]` or a person.

1. Create the agent at [githug.ai/app](/app) (or `hug agent create my-agent --repo owner/repo`). Copy its key.
2. Save it as a repository secret named `GITHUG_AGENT_KEY`.
3. Add these steps before the agent pushes:

```yaml
      - name: githug token
        env:
          GITHUG_AGENT_KEY: ${{ secrets.GITHUG_AGENT_KEY }}
        run: |
          curl -fsSL https://githug.ai/install | sh
          eval "$(hug env --repo ${{ github.repository }} --run ${{ github.run_id }})"
          echo "::add-mask::$GH_TOKEN"
          git config user.name "$GIT_AUTHOR_NAME"
          git config user.email "$GIT_AUTHOR_EMAIL"
          git commit -am "Agent changes" -m "$GITHUG_TRAILERS"
          hug attest --repo ${{ github.repository }}
          git push "https://x-access-token:${GH_TOKEN}@github.com/${{ github.repository }}.git" HEAD:agent/${{ github.run_id }}
```

`--run ${{ github.run_id }}` ties every key and commit to the workflow run, so the chain on [githug.ai/v](/v) links back to it. `hug attest` reports the new commits with the agent's key before the push, which is what makes them show as **verified** rather than just consistent. Keep the token inside one step: it lasts an hour, and `hug env` mints a new one each time you call it.
