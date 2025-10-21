// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config'; // .env 파일을 읽기 위해 추가

const app = express();
app.use(cors());
app.use(express.json());

// 1. OpenAI와 Spotify 클라이언트 설정
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// Spotify API 접근 토큰을 주기적으로 갱신하는 함수
const refreshSpotifyToken = async () => {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    console.log('Spotify access token refreshed!');
  } catch (err) {
    console.error('Could not refresh Spotify access token', err);
  }
};

// 2. API 엔드포인트 로직 업그레이드
app.post('/api/recommend-genres', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    // 3. Spotify에서 아티스트 검색 및 탑 트랙 가져오기
    const artistSearch = await spotifyApi.searchArtists(query, { limit: 1 });

    // ⭐ 해결책: 검색 결과가 있는지 여기서 먼저 확인합니다!
    if (!artistSearch.body.artists || artistSearch.body.artists.items.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    
    // 이 아래 코드는 이제 `artists`가 존재한다고 확신하고 실행할 수 있습니다.
    const artist = artistSearch.body.artists.items[0];
    const topTracksResponse = await spotifyApi.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks.slice(0, 5);

    // 4. OpenAI에 보낼 프롬프트 생성 (Spotify 정보 활용)
    const prompt = `
      You are a world-class music curator. A user is searching for an artist named "${artist.name}".
      Their top tracks are: ${topTracks.map(t => t.name).join(', ')}.
      Based on this artist's style, recommend 3 unique and interesting music genres.
      For each genre, provide a short, engaging description and 3 other representative artists.
      Do not recommend the genre "${artist.genres.join(', ')}" or the artist "${artist.name}".
      Provide the response strictly in JSON format like this:
      {
        "genres": [
          {"name": "Genre Name", "description": "Genre description.", "artists": ["Artist A", "Artist B", "Artist C"]},
          ...
        ]
      }
    `;

    // 5. OpenAI에 추천 요청
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
    });

    const aiGenres = JSON.parse(aiResponse.choices[0].message.content || '{}');

    // 6. 프론트엔드에 보낼 최종 데이터 조합
    const responseData = {
      searchedArtist: {
        name: artist.name,
        imageUrl: artist.images[0]?.url,
        topTracks: topTracks.map(track => ({
          title: track.name,
          album: track.album.name,
        })),
      },
      aiRecommendations: aiGenres.genres,
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  // 서버 시작 시 및 1시간마다 토큰 갱신
  refreshSpotifyToken();
  setInterval(refreshSpotifyToken, 1000 * 60 * 55); // 55분마다
});