import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import { isAfter, subMinutes, parseISO } from 'date-fns';

interface PullRequest {
  html_url: string;
  repository_url: string;
  number: number;
}

interface Review {
  state: string;
  user: {
    login: string;
  };
  submitted_at: string;
}

interface Comment {
  body: string;
}

interface Event {
  event: string;
  state: string;
  actor: {
    login: string;
  };
  created_at: string;
}

@Injectable()
export class GithubService {
  private readonly githubToken = process.env.GITHUB_TOKEN;
  private readonly username = process.env.GITHUB_NAME;
  private readonly orgs = process.env.GITHUB_ORGS?.split(',') || [];
  private readonly logger = new Logger(GithubService.name);

  private readonly memeUrls: string[] = [
    'https://media.makeameme.org/created/pr-approved-seeing.jpg',
    'https://www.memecreator.org/static/images/memes/5595060.jpg',
    'https://media.makeameme.org/created/you-get-approved-a0fd4c37ee.jpg',
    'http://www.quickmeme.com/img/17/17960076ed8eb9b005747677c781d58cfe237f192c0f0e4e243cd73bd789b3fc.jpg',
    'https://i.imgflip.com/8qwq96.jpg',
    'https://www.meme-arsenal.com/memes/cba08ac9b63f603c1f30495a45967708.jpg',
    'https://media.makeameme.org/created/i-got-you-b6b9066329.jpg',
    'https://i.pinimg.com/564x/e0/b9/32/e0b932da2b84a6bc012af9b9a5774087.jpg',
  ];

  private approvedRepos: Set<string> = new Set();

  async trackApprovedRepositories(): Promise<void> {
    const url = `https://api.github.com/search/issues?q=reviewed-by:${this.username}+type:pr+state:closed+sort:updated&order=desc&per_page=5`;

    this.logger.log('Buscando os últimos repositórios aprovados...');
    const response: AxiosResponse = await axios.get(url, {
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    response.data.items.forEach((pr: PullRequest) => {
      if (pr.repository_url) {
        const repoFullName = pr.repository_url.replace(
          'https://api.github.com/repos/',
          '',
        );
        this.approvedRepos.add(repoFullName);
      }
    });

    this.logger.log(
      `Repositórios aprovados recentemente: ${Array.from(this.approvedRepos).join(', ')}`,
    );
  }

  async getPullRequestsForRepos(repoNames: string[]): Promise<PullRequest[]> {
    const promises = repoNames.map(async (repoFullName) => {
      const url = `https://api.github.com/repos/${repoFullName}/pulls?state=open&sort=created&direction=desc`;

      this.logger.log(`Buscando PRs no repositório: ${repoFullName}`);
      const response: AxiosResponse = await axios.get(url, {
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      this.logger.log(
        `PRs encontradas no repositório ${repoFullName}: ${response.data.length}`,
      );
      return response.data as PullRequest[];
    });

    return (await Promise.all(promises)).flat();
  }

  async checkApprovedPRs(): Promise<void> {
    this.logger.log(
      'Iniciando verificação de PRs aprovadas nos últimos repositórios...',
    );

    await this.trackApprovedRepositories();

    const allRepos = Array.from(this.approvedRepos).filter((repoFullName) =>
      this.orgs.some((org) => repoFullName.startsWith(`${org}/`)),
    );

    const repoPRs = await this.getPullRequestsForRepos(allRepos);

    const fiveMinutesAgo = subMinutes(new Date(), 5);

    await Promise.all(
      repoPRs.map(async (pr) => {
        if (!pr.html_url || !pr.repository_url) {
          this.logger.warn(
            `PR #${pr.number} não possui dados completos (html_url ou repository_url), ignorando.`,
          );
          this.logger.debug(
            `Dados da PR incompleta: ${JSON.stringify(pr, null, 2)}`,
          );
          return;
        }

        try {
          const reviews = await this.getPullRequestReviews(pr.html_url)
            .then((rev) =>
              rev.length === 0
                ? this.getPullRequestEvents(
                    pr.repository_url.replace(
                      'https://api.github.com/repos/',
                      '',
                    ),
                    pr.number,
                  )
                : rev,
            )
            .catch((error) => {
              if (error.response?.status === HttpStatus.NOT_FOUND) {
                this.logger.warn(
                  `Revisões não encontradas para PR #${pr.number}.`,
                );
                return [];
              }
              throw error;
            });

          this.logger.debug(
            `Revisões encontradas para PR #${pr.number}: ${JSON.stringify(reviews, null, 2)}`,
          );

          const approvedReview = reviews.find(
            (review) =>
              review.state === 'APPROVED' &&
              review.user.login === this.username &&
              isAfter(parseISO(review.submitted_at), fiveMinutesAgo),
          );

          if (!approvedReview) {
            this.logger.log(
              `Nenhuma aprovação recente encontrada para a PR: ${pr.number}`,
            );
            return;
          }

          this.logger.log(`PR aprovada recentemente encontrada: ${pr.number}`);

          const repoFullName = pr.repository_url.replace(
            'https://api.github.com/repos/',
            '',
          );

          const comments = await this.getPullRequestComments(
            repoFullName,
            pr.number,
          );

          const memeAlreadyPosted = this.memeUrls.some((memeUrl) =>
            comments.some((comment) => comment.body.includes(memeUrl)),
          );

          if (memeAlreadyPosted) {
            this.logger.log('Um meme já foi postado anteriormente nesta PR.');
            return;
          }

          const memeUrl = this.getRandomMeme();
          await this.addMemeComment(repoFullName, pr.number, memeUrl);
        } catch (error) {
          this.logger.error(
            `Erro ao processar PR #${pr.number}: ${error.message}`,
          );
        }
      }),
    );

    this.logger.log('Verificação de PRs concluída.');
  }

  async getPullRequestReviews(pullRequestUrl?: string): Promise<Review[]> {
    if (!pullRequestUrl) {
      this.logger.warn(`URL da PR não fornecida, ignorando busca de reviews.`);
      return [];
    }

    this.logger.log(`Buscando reviews da PR: ${pullRequestUrl}`);
    try {
      const response: AxiosResponse = await axios.get(
        `${pullRequestUrl}/reviews`,
        {
          headers: {
            Authorization: `token ${this.githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      this.logger.log(`Reviews encontradas: ${response.data.length}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === HttpStatus.NOT_FOUND) {
        this.logger.warn(
          `Revisões não encontradas para PR em ${pullRequestUrl}.`,
        );
        return [];
      }
      this.logger.error(`Erro ao buscar reviews da PR: ${error.message}`);
      return [];
    }
  }

  async getPullRequestEvents(
    repoFullName: string,
    pullNumber: number,
  ): Promise<Review[]> {
    const eventsUrl = `https://api.github.com/repos/${repoFullName}/issues/${pullNumber}/events`;
    this.logger.log(`Buscando eventos da PR: ${eventsUrl}`);

    try {
      const response: AxiosResponse<Event[]> = await axios.get(eventsUrl, {
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      this.logger.log(`Eventos encontrados: ${response.data.length}`);

      return response.data
        .filter((event: Event) => event.event === 'reviewed')
        .map((event: Event) => ({
          state: event.state,
          user: event.actor,
          submitted_at: event.created_at,
        }));
    } catch (error) {
      this.logger.error(`Erro ao buscar eventos da PR: ${error.message}`);
      return [];
    }
  }

  async getPullRequestComments(
    repoFullName: string,
    pullNumber: number,
  ): Promise<Comment[]> {
    const issueCommentUrl = `https://api.github.com/repos/${repoFullName}/issues/${pullNumber}/comments`;
    this.logger.log(`Buscando comentários da PR: ${issueCommentUrl}`);

    try {
      const response: AxiosResponse<Comment[]> = await axios.get(
        issueCommentUrl,
        {
          headers: {
            Authorization: `token ${this.githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      this.logger.log(`Comentários encontrados: ${response.data.length}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Erro ao buscar comentários da PR: ${error.message}`);
      return [];
    }
  }

  getRandomMeme(): string {
    const randomIndex = Math.floor(Math.random() * this.memeUrls.length);
    const selectedMeme = this.memeUrls[randomIndex];
    this.logger.log(`Meme selecionado: ${selectedMeme}`);
    return selectedMeme;
  }

  async addMemeComment(
    repoFullName: string,
    pullNumber: number,
    memeUrl: string,
  ): Promise<void> {
    const issueCommentUrl = `https://api.github.com/repos/${repoFullName}/issues/${pullNumber}/comments`;
    this.logger.log(`Adicionando meme na PR: ${issueCommentUrl}`);

    try {
      await axios.post(
        issueCommentUrl,
        {
          body: `![Meme](${memeUrl})`,
        },
        {
          headers: {
            Authorization: `token ${this.githubToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      this.logger.log('Meme adicionado com sucesso!');
    } catch (error) {
      this.logger.error(`Erro ao adicionar meme na PR: ${error.message}`);
    }
  }
}
