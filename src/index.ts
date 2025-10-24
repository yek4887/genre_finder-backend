// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();

const allowedOrigins = ['https://genrefinder.xyz'];
const corsOptions: cors.CorsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isProduction = process.env.NODE_ENV === 'production';
// !! 중요: 개발/운영 환경 Redirect URI 구분은 이제 Spotify 인스턴스 생성 시 처리
const baseRedirectUri = '/api/callback'; // 경로만 정의

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  // redirectUri는 요청 시 동적으로 설정하거나, 기본 인스턴스에는 고정값 사용
  // 여기서는 authorizationCodeGrant에 필요 없으므로 일단 생략 가능
});

// 로그인 라우트
app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private']; // getMe를 위해 user-read-private 추가
  // 로그인 요청 시 환경에 맞는 Redirect URI 생성
  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, 'state-key', true, { redirect_uri: redirectUriFull });
  res.redirect(authorizeURL);
});

// 콜백 라우트
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  // 콜백 시에도 환경에 맞는 Redirect URI 사용
  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;

  // 임시 Spotify 인스턴스 생성 (redirectUri 설정 포함)
  const tempSpotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: redirectUriFull // 여기에 정확한 redirectUri 설정
  });

  try {
    // 임시 인스턴스로 토큰 교환 요청
    const data = await tempSpotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token, expires_in } = data.body;
    console.log("Received tokens:", { access_token: access_token?.substring(0,5), refresh_token: refresh_token?.substring(0,5), expires_in });

    // 프론트엔드로 두 토큰과 만료 시간 전달
    res.redirect(`https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`);
  } catch (err: any) {
    console.error('Callback Error:', err.message || err);
    if(err.body) console.error('Spotify Error Body:', err.body);
    res.status(err.statusCode || 400).send(`Error getting tokens: ${err.body?.error_description || err.message}`);
  }
});

// --- Access Token 갱신 API 추가 ---
app.post('/api/refresh_token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
    }
    console.log("Received refresh token request:", refreshToken.substring(0,5));

    // Refresh Token을 설정하여 새로운 Spotify API 인스턴스 생성 (기본 인스턴스 재사용 가능하나 분리)
    const refreshSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        refreshToken: refreshToken
    });

    try {
        const data = await refreshSpotifyApi.refreshAccessToken();
        const newAccessToken = data.body['access_token'];
        const newExpiresIn = data.body['expires_in'];
        console.log("Refreshed access token:", { newAccessToken: newAccessToken?.substring(0,5), newExpiresIn });

        res.json({
            accessToken: newAccessToken,
            expiresIn: newExpiresIn
        });
    } catch (err: any) {
        console.error('Could not refresh access token', err.message || err);
        if(err.body) console.error('Spotify Refresh Error Body:', err.body);
        res.status(err.statusCode || 400).json({ error: `Could not refresh access token: ${err.body?.error_description || err.message}` });
    }
});
// --- Access Token 갱신 API 끝 ---


// 장르 추천 라우트
app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  // ... (이하 로직은 이전과 거의 동일, 단 userSpotifyApi 생성 부분 확인) ...
   if (!query) return res.status(400).json({ error: 'Query is required' });
   if (!accessToken) return res.status(401).json({ error: 'Access Token is required'});
   console.log(`[${new Date().toISOString()}] Received recommend-genres request for query: ${query}`);

   // 요청마다 새로운 인스턴스를 생성하거나, 토큰을 설정해야 함
   const userSpotifyApi = new SpotifyWebApi();
   userSpotifyApi.setAccessToken(accessToken); // Access Token 설정

   try {
     let artist: any = null;
     // ... (Spotify 검색 및 OpenAI 호출 로직 동일) ...
     let searchStep = 'Initial'; // 디버깅용

      try {
        searchStep = 'Searching tracks';
        console.log(`Searching tracks for: ${query}`);
        const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
        if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
          searchStep = 'Getting artist from track';
          const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
          console.log(`Found track, getting artist ID: ${trackArtistId}`);
          const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
          artist = artistResponse.body;
        } else {
          searchStep = 'Searching artists';
          console.log(`Track not found, searching artists for: ${query}`);
          const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
          if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
            artist = artistSearch.body.artists.items[0];
          }
        }
      } catch (spotifySearchError: any) {
          console.error(`Error during Spotify search (${searchStep}):`, spotifySearchError.message || spotifySearchError);
          if(spotifySearchError.body) console.error('Spotify Search Error Body:', spotifySearchError.body);
          // 401 오류는 토큰 만료 가능성을 의미하므로 클라이언트에게 알림
          if (spotifySearchError.statusCode === 401) {
              return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
          }
          return res.status(spotifySearchError.statusCode || 503).json({ error: `Failed to search Spotify: ${spotifySearchError.body?.error?.message || spotifySearchError.message}` });
      }


      if (!artist) { /* ... 아티스트 없음 처리 동일 ... */ }
      console.log(`Found artist: ${artist.name}`);


      let topTracks: any[] = [];
      try { /* ... Top Tracks 조회 동일 (오류 시 빈 배열) ... */ }
      catch (topTrackError) { /* ... */ }

      const existingGenres = (artist.genres && artist.genres.length > 0) ? `...` : '';
      const prompt = `...`; // (프롬프트 동일)

      let aiGenres: any[] = []; // 기본값 빈 배열
      try { /* ... OpenAI 호출 및 파싱 동일 (오류 시 빈 배열) ... */ }
      catch (openaiError) { /* ... */ }

      let enrichedGenres: any[] = [];
      try { /* ... 이미지 조회 로직 동일 (개별 오류 처리) ... */ }
      catch (enrichError) { /* ... */ }

      const responseData = { /* ... 응답 데이터 구성 동일 ... */ };
      res.json(responseData);

   } catch (error: any) { // userSpotifyApi 사용 중 발생하는 모든 에러 처리
     console.error(`Unhandled error processing recommend-genres for query ${query}:`, error.message || error);
     if(error.body) console.error('Spotify General Error Body:', error.body);
      // 401 오류는 토큰 만료 가능성을 의미
     if (error.statusCode === 401) {
         return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
     }
     res.status(error.statusCode || 500).json({ error: `An unexpected error occurred: ${error.body?.error?.message || error.message}` });
   }
});


// 플레이리스트 저장 라우트
app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    // ... (입력값 검증 동일) ...
    if (!accessToken || !trackIds || !artistName) { /* ... */ }
    console.log(`[${new Date().toISOString()}] Received save-playlist request for artist: ${artistName}`);

    // 요청마다 새로운 인스턴스 또는 토큰 설정
    const userSpotifyApi = new SpotifyWebApi();
    userSpotifyApi.setAccessToken(accessToken);

    try {
        const meResponse = await userSpotifyApi.getMe();
        // ... (플레이리스트 생성 및 트랙 추가 로직 동일) ...
        const playlistName = `${artistName} inspired by Genre Finder`;
        const playlistResponse = await userSpotifyApi.createPlaylist(playlistName, { /* ... */ });
        const playlistId = playlistResponse.body.id;
        const playlistUrl = playlistResponse.body.external_urls.spotify;

        if (Array.isArray(trackIds) && trackIds.length > 0) { /* ... 트랙 추가 로직 동일 ... */ }
        else { /* ... */ }

        console.log(`Playlist created successfully for ${artistName}. URL: ${playlistUrl}`);
        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlistUrl });

    } catch (err: any) { // Spotify API 오류 처리 강화
        console.error(`Failed to create playlist for ${artistName}:`, err.message || err);
        if (err.body && err.body.error) {
            console.error('Spotify API Error during playlist creation:', err.body.error);
            // 401 오류는 토큰 만료 가능성
            if (err.statusCode === 401) {
                return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
            }
            return res.status(err.statusCode || 500).json({ error: `Spotify API Error: ${err.body.error.message}` });
        }
        res.status(500).json({ error: 'Internal server error during playlist creation.' });
    }
});

// 서버 포트 설정 및 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});