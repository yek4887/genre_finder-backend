// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore - 라이브러리 타입 정의를 찾지 못할 경우를 대비한 주석
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();

const corsOptions = {
  origin: 'https://genrefinder.xyz', // Vercel 프론트엔드 주소
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions)); // CORS 미들웨어를 먼저 적용
app.use(express.json());   // 그 다음에 JSON 파싱 미들웨어 적용

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 환경에 따라 Redirect URI 동적 설정
const isProduction = process.env.NODE_ENV === 'production';
const redirectUri = isProduction
  ? `${process.env.BACKEND_URL}/api/callback` // 실제 서버 환경
  : 'http://127.0.0.1:8080/api/callback';   // 로컬 개발 환경

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
});

// Spotify 로그인 라우트
app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, 'state-key', true);
  res.redirect(authorizeURL);
});

// Spotify 로그인 콜백 라우트
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token } = data.body;
    // 토큰을 프론트엔드로 전달하며 리디렉션
    res.redirect(`https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}`);
  } catch (err) {
    console.error('Callback Error:', err);
    res.status(400).send('Error getting tokens');
  }
});

// 장르 추천 API 라우트
app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  // 입력값 검증
  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (!accessToken) return res.status(401).json({ error: 'Access Token is required'});

  // 사용자 토큰으로 Spotify API 클라이언트 생성
  const userSpotifyApi = new SpotifyWebApi({ accessToken });

  try {
    let artist: any = null;

    // 1. 먼저 곡으로 검색
    const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
    if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
      // 곡을 찾으면 해당 곡의 아티스트 정보 사용
      const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
      const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
      artist = artistResponse.body;
    } else {
      // 2. 곡이 없으면 아티스트로 검색
      const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
      if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
        artist = artistSearch.body.artists.items[0];
      }
    }

    // 아티스트 정보 확인
    if (!artist) {
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    
    // 대표곡 조회 (US 마켓 기준)
    const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
        name: track.name,
        url: track.external_urls.spotify,
        preview_url: track.preview_url // 미리듣기 URL (사용하지 않지만 포함)
    }));

    // OpenAI 프롬프트 생성 (아티스트 장르 정보 안전하게 처리)
    const existingGenres = (artist.genres && artist.genres.length > 0)
      ? `Do not recommend the genre "${artist.genres.join(', ')}".`
      : '';

    const prompt = `
      You are a world-class music curator. A user is searching for music related to "${artist.name}".
      Based on this artist's style, recommend 3 unique and interesting music genres.
      For each genre, provide a short, engaging description and 3 other representative artists.
      ${existingGenres}
      Do not recommend the artist "${artist.name}".
      Provide the response strictly in JSON format like this, including spotifyTrackIds for each recommended artist's top track:
      {
        "genres": [
          { "name": "Genre Name", "description": "...", "artists": [{"artistName": "...", "spotifyTrackId": "..."}, ...] },
          ...
        ]
      }
    `;
    
    // OpenAI API 호출
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // 비용 효율적인 모델 사용
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }, // JSON 응답 형식 강제
    });

    let aiGenres;
    try {
      // AI 응답 파싱 (실패 시 빈 배열 반환)
      const aiResponse = completion.choices[0].message.content;
      aiGenres = aiResponse ? JSON.parse(aiResponse).genres : [];
    } catch (e) {
      console.error("Failed to parse AI response:", e);
      aiGenres = []; // 파싱 실패 시 안전하게 빈 배열
    }

    // AI 추천 장르의 대표 아티스트 이미지 조회 (오류 처리 강화)
    console.log("AI Genres before image fetch:", JSON.stringify(aiGenres, null, 2)); // 데이터 확인용 로그
    const enrichedGenres = await Promise.all(
      (aiGenres || []).map(async (genre: any) => {
        let imageUrl: string | null = null; // 이미지 URL 초기값은 null
        try {
          // 장르 정보 및 아티스트 목록이 유효한지 확인
          if (genre && genre.artists && genre.artists.length > 0 && genre.artists[0].artistName) {
            // 첫 번째 아티스트 이름으로 Spotify 검색
            const artistSearch = await userSpotifyApi.searchArtists(genre.artists[0].artistName, { limit: 1 });
            // 검색 결과 및 이미지 URL 유효성 확인 후 할당
            if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
              imageUrl = artistSearch.body.artists.items[0].images[0]?.url || null; // 이미지가 없으면 null
            }
          }
        } catch (error) {
            // 이미지 조회 중 오류 발생 시 로그 기록 (전체 프로세스 중단 없음)
            console.error(`Failed to fetch image for ${genre.artists[0]?.artistName}:`, error);
        }
        // 기존 장르 정보에 이미지 URL 추가 (null일 수 있음)
        return { ...genre, imageUrl };
      })
    );
    console.log("Enriched Genres after image fetch:", JSON.stringify(enrichedGenres, null, 2)); // 데이터 확인용 로그

    // 최종 응답 데이터 구성
    const responseData = {
      searchedArtist: {
        name: artist.name,
        imageUrl: artist.images[0]?.url,
      },
      topTracks: topTracks,
      aiRecommendations: enrichedGenres,
    };

    // 클라이언트에 JSON 응답 전송
    res.json(responseData);

  } catch (error) {
    // API 처리 중 발생한 모든 오류 로깅 및 500 에러 응답
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// 플레이리스트 저장 API 라우트
app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    // 필수 파라미터 검증
    if (!accessToken || !trackIds || !artistName) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const userSpotifyApi = new SpotifyWebApi({ accessToken });

    try {
        // 플레이리스트 이름 생성
        const playlistName = `${artistName} inspired by Genre Finder`;
        // 플레이리스트 생성 요청
        const playlist = await userSpotifyApi.createPlaylist(playlistName, {
            public: false, // 비공개 플레이리스트로 생성
            description: `AI recommended tracks based on ${artistName}. Created by Genre Finder.`
        });
        const playlistId = playlist.body.id; // 생성된 플레이리스트 ID

        // 트랙 ID 목록을 Spotify URI 형식으로 변환
        const spotifyTrackUris = trackIds.map((id: string) => `spotify:track:${id}`);
        // 플레이리스트에 트랙 추가 요청
        await userSpotifyApi.addTracksToPlaylist(playlistId, spotifyTrackUris);

        // 성공 응답 전송
        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlist.body.external_urls.spotify });

    } catch (err) {
        // 오류 로깅 및 500 에러 응답
        console.error('Failed to create playlist', err);
        res.status(500).json({ error: 'Failed to create playlist.' });
    }
});

// 서버 포트 설정 및 실행
const PORT = process.env.PORT || 8080; // Render 환경을 위해 PORT 환경 변수 사용
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
