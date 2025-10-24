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
const baseRedirectUri = '/api/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private'];
  const state = 'state-key';
  const showDialog = true;
  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;
  const authorizeURLBase = spotifyApi.createAuthorizeURL(scopes, state, showDialog);
  const authorizeURLWithRedirect = `${authorizeURLBase}&redirect_uri=${encodeURIComponent(redirectUriFull)}`;
  console.log("Redirecting to Spotify for login:", authorizeURLWithRedirect);
  res.redirect(authorizeURLWithRedirect);
});

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

  const redirectUriFull = isProduction
    ? `${process.env.BACKEND_URL}${baseRedirectUri}`
    : `http://127.0.0.1:8080${baseRedirectUri}`;

  const tempSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: redirectUriFull
  });

  try {
    console.log("Attempting authorizationCodeGrant with code:", code?.toString().substring(0, 5) + "...");
    const data = await tempSpotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token, expires_in } = data.body;
    console.log("Successfully received tokens from Spotify:", { access_token: access_token?.substring(0,5), refresh_token: refresh_token?.substring(0,5), expires_in });
    const frontendRedirectUrl = `https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`;
    console.log("Redirecting to frontend with tokens...");
    res.redirect(frontendRedirectUrl);
  } catch (err: any) {
    console.error('Callback Token Grant Error:', err.message || err);
    if(err.body) console.error('Spotify Token Grant Error Body:', err.body);
    res.status(err.statusCode || 500).send(`Error getting tokens: ${err.body?.error_description || err.message}`);
   }
});

app.post('/api/refresh_token', async (req, res) => {
    const { refreshToken } = req.body;
     if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
    }
    console.log("Received refresh token request:", refreshToken.substring(0,5)+"...");

    // Refresh Token 설정 (기본 인스턴스 사용)
    spotifyApi.setRefreshToken(refreshToken);

    try {
        // Access Token 갱신 요청
        const data = await spotifyApi.refreshAccessToken();
        const newAccessToken = data.body['access_token'];
        const newExpiresIn = data.body['expires_in'];
        console.log("Refreshed access token successfully:", { newAccessToken: newAccessToken?.substring(0,5), newExpiresIn });

        // Refresh Token 초기화 (보안상 다음 요청 시 다시 설정하도록)
        spotifyApi.setRefreshToken('');

        // 새로운 Access Token과 만료 시간 응답
        res.json({
            accessToken: newAccessToken,
            expiresIn: newExpiresIn // 클라이언트에서 만료 시간 계산하도록 초 단위 전달
        });
    } catch (err: any) {
        // Refresh Token 초기화 (오류 발생 시에도)
        spotifyApi.setRefreshToken('');
        console.error('Could not refresh access token', err.message || err);
        if(err.body) console.error('Spotify Refresh Error Body:', err.body);
        res.status(err.statusCode || 400).json({ error: `Could not refresh access token: ${err.body?.error_description || err.message}` });
    }
});

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
     }
    catch (spotifySearchError: any) {
        console.error(`Error during Spotify search (${searchStep}):`, spotifySearchError.message || spotifySearchError);
        if(spotifySearchError.body) console.error('Spotify Search Error Body:', spotifySearchError.body);
        if (spotifySearchError.statusCode === 401) {
            return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
        }
        return res.status(spotifySearchError.statusCode || 503).json({ error: `Failed to search Spotify: ${spotifySearchError.body?.error?.message || spotifySearchError.message}` });
    }

    if (!artist) {
        console.log(`Artist or Track not found for query: ${query}`);
        return res.status(404).json({ error: 'Artist or Track not found' });
     }
    console.log(`Found artist: ${artist.name}`);

    let topTracks: any[] = [];
    try {
        console.log(`Getting top tracks for artist ID: ${artist.id}`);
        const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US'); // US 마켓 기준
        topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
            name: track.name,
            url: track.external_urls.spotify,
            preview_url: track.preview_url
        }));
     }
    catch (topTrackError: any) {
        console.error(`Error getting top tracks for ${artist.name}:`, topTrackError.message || topTrackError);
        if(topTrackError.body) console.error('Spotify Top Tracks Error Body:', topTrackError.body);
        // 대표곡 조회 실패는 치명적이지 않으므로 빈 배열로 계속 진행
     }

    const existingGenres = (artist.genres && artist.genres.length > 0)
        ? `Do not recommend the genre "${artist.genres.join(', ')}".`
        : '';

       // server/src/index.ts 파일에서 prompt 부분을 찾아 아래 내용으로 교체

    const prompt = `
    You are a world-class music curator with deep knowledge of music from various countries including Korea, Japan, the UK, and the US.
    A user is searching for music related to "${artist.name}".
    Based on this artist's style, recommend 3 unique and interesting music genres.
    For each genre, provide a short, engaging description and up to 6 other representative artists.
    ${existingGenres}
    Do not recommend the artist "${artist.name}".
    Crucially, if relevant to the genre, try to include a diverse mix of artists from different countries like Korea, Japan, the UK, or the US.
    IMPORTANT: Do NOT include country indicators like (US), (UK), (KR) next to the artist names. Just list the names.
    Provide the response strictly in JSON format like this, including spotifyTrackIds for each recommended artist's top track:
    {
      "genres": [
        {
          "name": "Genre Name",
          "description": "...",
          "artists": [{"artistName": "Artist A", "spotifyTrackId": "..."}, ...] // Up to 6 artists
        },
        ...
      ]
    }
  `;

    let aiGenres: any[] = [];
    try {
      console.log(`Sending request to OpenAI for artist: ${artist.name}`);
      // timeout 옵션은 두 번째 인자(options) 객체 안에 넣습니다.
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }, { timeout: 20000 }); // 20초 타임아웃

      const aiResponse = completion.choices[0].message.content;
      if (aiResponse) {
          try {
              aiGenres = JSON.parse(aiResponse).genres || [];
              console.log(`Received AI genres for ${artist.name}`);
          } catch (parseError) {
                console.error("Failed to parse AI response JSON:", parseError, "Response was:", aiResponse);
           }
      } else {
            console.warn(`OpenAI returned empty content for ${artist.name}`);
       }
    } catch (openaiError: any) {
        console.error(`Error calling OpenAI for ${artist.name}:`, openaiError.message || openaiError);
        if (openaiError.response) console.error("OpenAI Error Response:", openaiError.response.data);
     }

    let enrichedGenres: any[] = [];
    try {
        console.log(`Fetching images for AI recommended artists...`);
        enrichedGenres = await Promise.all(
          (aiGenres || []).map(async (genre: any) => {
            let imageUrl: string | null = null;
            try {
              if (genre && genre.artists && genre.artists.length > 0 && genre.artists[0].artistName) {
                // 주의: Access Token이 설정된 userSpotifyApi 사용
                const artistSearch = await userSpotifyApi.searchArtists(genre.artists[0].artistName, { limit: 1 });
                if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
                  imageUrl = artistSearch.body.artists.items[0].images[0]?.url || null;
                }
              }
            } catch (imageError: any) {
                console.error(`Failed to fetch image for ${genre.artists[0]?.artistName}:`, imageError.message || imageError);
                 if(imageError.body) console.error('Spotify Image Search Error Body:', imageError.body);
                 // 개별 이미지 오류는 무시하고 계속 진행
            }
            return { ...genre, imageUrl };
          })
        );
         console.log(`Finished fetching images.`);
     }
    catch (enrichError) {
        // Promise.all 자체에서 발생할 수 있는 예외 처리 (거의 발생 안 함)
        console.error("Unexpected error during genre enrichment (image fetching):", enrichError);
        enrichedGenres = aiGenres; // 이미지 조회가 실패하면 원본 AI 결과 사용
     }

    const responseData = {
        searchedArtist: { name: artist.name, imageUrl: artist.images[0]?.url },
        topTracks: topTracks,
        aiRecommendations: enrichedGenres,
     };
    console.log(`Successfully processed recommend-genres request for query: ${query}`);
    res.json(responseData);

  } catch (error: any) {
     // 핸들러 내에서 예상치 못한 모든 오류 처리
    console.error(`Unhandled error in recommend-genres for query ${query}:`, error.message || error);
    if(error.body) console.error('Spotify General Error Body:', error.body);
    // 401 오류는 토큰 만료 가능성
    if (error.statusCode === 401) {
        return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
    }
    res.status(error.statusCode || 500).json({ error: `An unexpected error occurred: ${error.body?.error?.message || error.message}` });
  }
});

app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    // 입력값 검증
    if (!accessToken || !trackIds || !artistName) {
      console.warn('Save Playlist: Missing required parameters.');
      return res.status(400).json({ error: 'Missing required parameters.' });
    }
    console.log(`[${new Date().toISOString()}] Received save-playlist request for artist: ${artistName}`);

    // 요청별 Spotify API 인스턴스 사용 또는 토큰 설정
    const userSpotifyApi = new SpotifyWebApi();
    userSpotifyApi.setAccessToken(accessToken);

    try {
        // 플레이리스트 이름 생성
        const playlistName = `${artistName} inspired by Genre Finder`;
        // 플레이리스트 생성 요청
        console.log(`Creating playlist: ${playlistName}`);
        const playlistResponse = await userSpotifyApi.createPlaylist(playlistName, {
            public: false, // 비공개
            description: `AI recommended tracks based on ${artistName}. Created by Genre Finder.`
        });
        const playlistId = playlistResponse.body.id;
        const playlistUrl = playlistResponse.body.external_urls.spotify;
        console.log(`Playlist created with ID: ${playlistId}`);

        // 트랙 ID 목록 유효성 검사 및 URI 변환
        if (Array.isArray(trackIds) && trackIds.length > 0) {
            const spotifyTrackUris = trackIds
                .filter(id => typeof id === 'string' && id.trim() !== '') // 유효한 ID 문자열만 필터링
                .map((id: string) => `spotify:track:${id}`); // URI 형식으로 변환

            if (spotifyTrackUris.length > 0) {
                 // 플레이리스트에 트랙 추가 (API는 최대 100개씩 가능, 필요시 분할)
                 console.log(`Adding ${spotifyTrackUris.length} tracks to playlist ${playlistId}`);
                 // Spotify API는 한 번에 100개까지만 추가 가능하므로, 필요시 청크로 나눠야 함
                 const chunkSize = 100;
                 for (let i = 0; i < spotifyTrackUris.length; i += chunkSize) {
                     const chunk = spotifyTrackUris.slice(i, i + chunkSize);
                     await userSpotifyApi.addTracksToPlaylist(playlistId, chunk);
                     console.log(`Added chunk of ${chunk.length} tracks.`);
                 }
            } else {
                console.warn("No valid track IDs provided to add to the playlist.");
            }
        } else {
             console.warn("trackIds parameter is not a valid array or is empty.");
        }

        console.log(`Playlist creation complete for ${artistName}. URL: ${playlistUrl}`);
        // 성공 응답
        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlistUrl });

    } catch (err: any) {
        // 플레이리스트 생성/추가 실패 시 상세 오류 처리
        console.error(`Failed to save playlist for ${artistName}:`, err.message || err);
        if (err.body && err.body.error) {
            console.error('Spotify API Error during playlist save:', err.body.error);
            // 401 오류는 토큰 만료 가능성
            if (err.statusCode === 401) {
                return res.status(401).json({ error: 'Spotify access token might be expired. Please try refreshing.' });
            }
            return res.status(err.statusCode || 500).json({ error: `Spotify API Error: ${err.body.error.message}` });
        }
        // 일반적인 서버 오류 응답
        res.status(500).json({ error: 'Internal server error during playlist creation.' });
    }
});

// 서버 포트 설정 및 실행
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});