// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai'; // OpenAI import 확인
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore - 타입 선언 문제를 임시로 무시
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();

const allowedOrigins = ['https://genrefinder.xyz']; // 허용할 프론트엔드 주소
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

app.use(cors(corsOptions)); // CORS 먼저 적용
app.use(express.json());   // JSON 파싱 다음 적용

// OpenAI 클라이언트 초기화
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Spotify API 설정
const isProduction = process.env.NODE_ENV === 'production';
const baseRedirectUri = '/api/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
  // redirectUri는 요청 시점에 설정
});

// --- API 라우트 ---

// 1. 로그인 시작
app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private'];
  const state = 'state-key'; // 실제 앱에서는 랜덤 생성 및 검증 필요
  const showDialog = true;

  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;

  const authorizeURLBase = spotifyApi.createAuthorizeURL(scopes, state, showDialog);
  const authorizeURLWithRedirect = `${authorizeURLBase}&redirect_uri=${encodeURIComponent(redirectUriFull)}`;

  console.log("Redirecting to Spotify for login:", authorizeURLWithRedirect);
  res.redirect(authorizeURLWithRedirect);
});

// 2. Spotify 로그인 콜백
app.get('/api/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Callback Error from Spotify:', error);
    return res.status(400).send(`Error during Spotify authorization: ${error}`);
  }
  if (!code) {
    console.error('Callback Error: No code received from Spotify.');
    return res.status(400).send('Error: No authorization code received.');
  }

  // state 검증 로직 추가 필요

  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;

  // 콜백 처리를 위한 임시 인스턴스 또는 기본 인스턴스에 Redirect URI 설정
  spotifyApi.setRedirectURI(redirectUriFull);

  try {
    console.log("Attempting authorizationCodeGrant with code:", code?.toString().substring(0, 5) + "...");
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token, expires_in } = data.body;
    console.log("Successfully received tokens from Spotify:", { access_token: access_token?.substring(0,5), refresh_token: refresh_token?.substring(0,5), expires_in });

    spotifyApi.setRedirectURI(''); // 사용 후 초기화

    const frontendRedirectUrl = `https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`;
    console.log("Redirecting to frontend with tokens...");
    res.redirect(frontendRedirectUrl);

  } catch (err: any) {
    spotifyApi.setRedirectURI(''); // 오류 시에도 초기화
    console.error('Callback Token Grant Error:', err.message || err);
    if(err.body) console.error('Spotify Token Grant Error Body:', err.body);
    res.status(err.statusCode || 500).send(`Error getting tokens: ${err.body?.error_description || err.message}`);
  }
});

// 3. Access Token 갱신
app.post('/api/refresh_token', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
    }
    console.log("Received refresh token request:", refreshToken.substring(0,5)+"...");

    spotifyApi.setRefreshToken(refreshToken);

    try {
        const data = await spotifyApi.refreshAccessToken();
        const newAccessToken = data.body['access_token'];
        const newExpiresIn = data.body['expires_in'];
        console.log("Refreshed access token successfully:", { newAccessToken: newAccessToken?.substring(0,5), newExpiresIn });

        spotifyApi.setRefreshToken(''); // 사용 후 초기화

        res.json({
            accessToken: newAccessToken,
            expiresIn: newExpiresIn
        });
    } catch (err: any) {
        spotifyApi.setRefreshToken(''); // 오류 시에도 초기화
        console.error('Could not refresh access token', err.message || err);
        if(err.body) console.error('Spotify Refresh Error Body:', err.body);
        res.status(err.statusCode || 400).json({ error: `Could not refresh access token: ${err.body?.error_description || err.message}` });
    }
});

// 4. 장르 추천
app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  console.log(`[${new Date().toISOString()}] Received recommend-genres request for query: ${query}`);
  if (!query) { console.warn("Query is missing"); return res.status(400).json({ error: 'Query is required' }); }
  if (!accessToken) { console.warn("Access Token is missing"); return res.status(401).json({ error: 'Access Token is required'}); }

  const userSpotifyApi = new SpotifyWebApi();
  userSpotifyApi.setAccessToken(accessToken);

  try {
    let artist: any = null;
    let searchStep = 'Initial';
    // 아티스트/트랙 검색 로직
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
        if (spotifySearchError.statusCode === 401) {
            return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
        }
        return res.status(spotifySearchError.statusCode || 503).json({ error: `Failed to search Spotify: ${spotifySearchError.body?.error?.message || spotifySearchError.message}` });
    }

    // 아티스트 확인
    if (!artist) {
      console.log(`Artist or Track not found for query: ${query}`);
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    console.log(`Found artist: ${artist.name}`);

    // 대표곡 조회
    let topTracks: any[] = [];
    try {
        console.log(`Getting top tracks for artist ID: ${artist.id}`);
        const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US');
        topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
            name: track.name,
            url: track.external_urls.spotify,
            preview_url: track.preview_url
        }));
     }
    catch (topTrackError: any) {
        console.error(`Error getting top tracks for ${artist.name}:`, topTrackError.message || topTrackError);
        if(topTrackError.body) console.error('Spotify Top Tracks Error Body:', topTrackError.body);
     }

    // OpenAI 프롬프트 생성
    const existingGenres = (artist.genres && artist.genres.length > 0)
      ? `Do not recommend the genre "${artist.genres.join(', ')}".`
      : '';
    // server/src/index.ts 파일에서 prompt 부분을 찾아 아래 내용으로 교체

    const prompt = `
      You are a world-class music curator with deep knowledge of music from various countries.
      A user is searching for music related to "${artist.name}".
      Based on this artist's style:
      1. Recommend EXACTLY 3 unique and interesting music genres. No more, no less.
      2. For EACH of these 3 genres, provide a short, engaging description AND list EXACTLY 6 representative artists if possible. Listing 6 artists per genre is a primary requirement.
      ${existingGenres}
      Do not recommend the artist "${artist.name}".
      Try to include a diverse mix of artists from different countries like Korea, Japan, the UK, or the US, if relevant.
      IMPORTANT: Do NOT include country indicators like (US), (UK), (KR) next to the artist names.
      Provide the response strictly in JSON format like this, ensuring the top-level "genres" array contains EXACTLY 3 items, and EACH 'artists' array ideally contains 6 items:
      {
        "genres": [ // MUST contain EXACTLY 3 genre objects
          {
            "name": "Genre Name 1",
            "description": "...",
            "artists": [ // MUST contain 6 artists if possible
              {"artistName": "Artist 1", "spotifyTrackId": "..."},
              {"artistName": "Artist 2", "spotifyTrackId": "..."},
              {"artistName": "Artist 3", "spotifyTrackId": "..."},
              {"artistName": "Artist 4", "spotifyTrackId": "..."},
              {"artistName": "Artist 5", "spotifyTrackId": "..."},
              {"artistName": "Artist 6", "spotifyTrackId": "..."}
            ]
          },
          {
            "name": "Genre Name 2",
            "description": "...",
            "artists": [ /* 6 artists */ ]
          },
          {
            "name": "Genre Name 3",
            "description": "...",
            "artists": [ /* 6 artists */ ]
          }
        ]
      }
    `;

    // OpenAI API 호출
    let aiGenres: any[] = [];
    let completion: OpenAI.Chat.Completions.ChatCompletion | null = null; // completion 변수 외부 선언

    try {
      console.log(`Sending request to OpenAI for artist: ${artist.name}`);
      completion = await openai.chat.completions.create({
        // ▼▼▼ 이 부분을 수정하세요 ▼▼▼
        model: "gpt-4o", // 모델 이름을 gpt-4o로 변경
        // ▲▲▲ 이 부분을 수정하세요 ▲▲▲
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }, { timeout: 30000 }); // GPT-4o는 응답이 조금 더 느릴 수 있으므로 타임아웃을 30초로 늘립니다.

      const aiResponse = completion?.choices[0]?.message?.content; // ?. 사용
      if (aiResponse) {
          try {
              aiGenres = JSON.parse(aiResponse).genres || [];
              console.log(`Received AI genres for ${artist.name}`);
          } catch (parseError) {
                console.error("Failed to parse AI response JSON:", parseError, "Response was:", aiResponse);
          }
      } else {
            console.warn(`OpenAI returned empty or invalid content for ${artist.name}`);
            if(completion) console.log("OpenAI raw completion:", completion);
       }
    } catch (openaiError: any) {
         console.error(`Error calling OpenAI for ${artist.name}:`, openaiError.message || openaiError);
        if (openaiError.response) console.error("OpenAI Error Response:", openaiError.response.data);
     }

    // 대표 아티스트 이미지 조회
    let enrichedGenres: any[] = [];
    try {
        console.log(`Fetching images for AI recommended artists...`);
        enrichedGenres = await Promise.all(
          (aiGenres || []).map(async (genre: any, index: number) => { // index 추가
            if (!genre || typeof genre !== 'object') {
                console.warn(`Invalid genre object found at index ${index}. Skipping.`);
                return null;
            }
            let imageUrl: string | null = null;
            const firstArtist = genre.artists?.[0];
            try {
              if (firstArtist && firstArtist.artistName) {
                // console.log(`[Image Fetch ${index+1}/${aiGenres.length}] Searching for: ${firstArtist.artistName}`); // 로그 너무 많으면 주석 처리
                const artistSearch = await userSpotifyApi.searchArtists(firstArtist.artistName, { limit: 1 });
                if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
                  imageUrl = artistSearch.body.artists.items[0].images[0]?.url || null;
                  // console.log(`[Image Fetch ${index+1}] Found image for ${firstArtist.artistName}: ${imageUrl ? 'Yes' : 'No'}`);
                } else {
                    // console.log(`[Image Fetch ${index+1}] Artist not found on Spotify: ${firstArtist.artistName}`);
                }
              } else {
                  // console.warn(`[Image Fetch ${index+1}] No valid artist info for genre: ${genre.name}`);
              }
            } catch (imageError: any) {
                console.error(`[Image Fetch ${index+1}] FAILED for ${firstArtist?.artistName}:`, imageError.message || imageError);
            }
            return { ...genre, imageUrl };
          })
        );
        enrichedGenres = enrichedGenres.filter(g => g !== null); // null 제거
        console.log(`Finished fetching images successfully for ${enrichedGenres.length} genres.`);
    } catch (enrichError) {
        console.error("CRITICAL Error during Promise.all for image fetching:", enrichError);
        enrichedGenres = aiGenres.map((g: any) => ({ ...g, imageUrl: null })); // Fallback
    }

    // 최종 응답 데이터 구성
    const responseData = {
      searchedArtist: { name: artist.name, imageUrl: artist.images[0]?.url },
      topTracks: topTracks,
      aiRecommendations: enrichedGenres,
    };

    console.log(`Successfully processed recommend-genres request for query: ${query}`);
    res.json(responseData);

  } catch (error: any) {
    console.error(`Unhandled fatal error in recommend-genres for query ${query}:`, error.message || error);
    if(error.body) console.error('Error Body:', error.body); // General error body log
    res.status(error.statusCode || 500).json({ error: `An unexpected server error occurred.` });
  }
});

// 5. 플레이리스트 저장
app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    if (!accessToken || !trackIds || !artistName) { /* ... */ }
    console.log(`[${new Date().toISOString()}] Received save-playlist request for artist: ${artistName}`);

    const userSpotifyApi = new SpotifyWebApi();
    userSpotifyApi.setAccessToken(accessToken);

    try {
        const playlistName = `${artistName} inspired by Genre Finder`;
        console.log(`Creating playlist: ${playlistName}`);
        const playlistResponse = await userSpotifyApi.createPlaylist(playlistName, { /* ... */ });
        const playlistId = playlistResponse.body.id;
        const playlistUrl = playlistResponse.body.external_urls.spotify;
        console.log(`Playlist created with ID: ${playlistId}`);

        if (Array.isArray(trackIds) && trackIds.length > 0) {
            const spotifyTrackUris = trackIds
                .filter(id => typeof id === 'string' && id.trim() !== '')
                .map((id: string) => `spotify:track:${id}`);

            if (spotifyTrackUris.length > 0) {
                 console.log(`Adding ${spotifyTrackUris.length} tracks to playlist ${playlistId}`);
                 const chunkSize = 100;
                 for (let i = 0; i < spotifyTrackUris.length; i += chunkSize) {
                     const chunk = spotifyTrackUris.slice(i, i + chunkSize);
                     await userSpotifyApi.addTracksToPlaylist(playlistId, chunk);
                     console.log(`Added chunk of ${chunk.length} tracks.`);
                 }
            } else { /* ... */ }
        } else { /* ... */ }

        console.log(`Playlist creation complete for ${artistName}. URL: ${playlistUrl}`);
        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlistUrl });

    } catch (err: any) { /* ... 에러 처리 (이전과 동일) ... */ }
});

// 서버 포트 설정 및 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
