// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();

// --- CORS 설정 시작 (가장 중요!) ---
// 허용할 출처를 명확히 지정합니다.
const allowedOrigins = ['https://genrefinder.xyz'];

const corsOptions: cors.CorsOptions = {
  origin: function (origin, callback) {
    // 요청 출처(origin)가 허용 목록에 있거나, origin이 없는 경우(예: Postman) 허용
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200 // 일부 레거시 브라우저 호환성
};

// 모든 라우트 처리 전에 CORS 미들웨어를 적용합니다.
// 이렇게 하면 OPTIONS 사전 요청도 이 미들웨어에서 처리됩니다.
app.use(cors(corsOptions));
// --- CORS 설정 끝 ---

// JSON 파싱 미들웨어는 CORS 다음에 적용합니다.
app.use(express.json());

// --- 나머지 설정 및 API 라우트 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isProduction = process.env.NODE_ENV === 'production';
const redirectUri = isProduction
  ? `${process.env.BACKEND_URL}/api/callback`
  : 'http://127.0.0.1:8080/api/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
});

// 로그인 라우트
app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, 'state-key', true);
  res.redirect(authorizeURL);
});

// 콜백 라우트
app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token } = data.body;
    res.redirect(`https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}`);
  } catch (err) {
    console.error('Callback Error:', err);
    res.status(400).send('Error getting tokens');
  }
});

// 장르 추천 라우트
app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (!accessToken) return res.status(401).json({ error: 'Access Token is required'});

  const userSpotifyApi = new SpotifyWebApi({ accessToken });

  try {
    let artist: any = null;

    const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
    if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
      const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
      const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
      artist = artistResponse.body;
    } else {
      const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
      if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
        artist = artistSearch.body.artists.items[0];
      }
    }

    if (!artist) {
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    
    const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
        name: track.name,
        url: track.external_urls.spotify,
        preview_url: track.preview_url
    }));

    const existingGenres = (artist.genres && artist.genres.length > 0)
      ? `Do not recommend the genre "${artist.genres.join(', ')}".`
      : '';

    const prompt = `
      You are a world-class music curator... (이하 프롬프트 동일)
    `;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    let aiGenres;
    try {
      const aiResponse = completion.choices[0].message.content;
      aiGenres = aiResponse ? JSON.parse(aiResponse).genres : [];
    } catch (e) {
      console.error("Failed to parse AI response:", e);
      aiGenres = [];
    }

    const enrichedGenres = await Promise.all(
      (aiGenres || []).map(async (genre: any) => {
        let imageUrl: string | null = null;
        try {
          if (genre.artists && genre.artists.length > 0 && genre.artists[0].artistName) {
            const artistSearch = await userSpotifyApi.searchArtists(genre.artists[0].artistName, { limit: 1 });
            if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
              imageUrl = artistSearch.body.artists.items[0].images[0]?.url || null;
            }
          }
        } catch (error) {
            console.error(`Failed to fetch image for ${genre.artists[0]?.artistName}:`, error);
        }
        return { ...genre, imageUrl };
      })
    );

    const responseData = {
      searchedArtist: { name: artist.name, imageUrl: artist.images[0]?.url },
      topTracks: topTracks,
      aiRecommendations: enrichedGenres,
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// 플레이리스트 저장 라우트
app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    if (!accessToken || !trackIds || !artistName) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const userSpotifyApi = new SpotifyWebApi({ accessToken });

    try {
        const meResponse = await userSpotifyApi.getMe(); // 사용자 ID 가져오기 추가됨
        const userId = meResponse.body.id; // 이 변수는 현재 사용되지 않으나 필요시 사용 가능

        const playlistName = `${artistName} inspired by Genre Finder`;
        const playlistResponse = await userSpotifyApi.createPlaylist(playlistName, {
            public: false,
            description: `AI recommended tracks based on ${artistName}. Created by Genre Finder.`
        });
        const playlistId = playlistResponse.body.id;
        const playlistUrl = playlistResponse.body.external_urls.spotify;

        if (Array.isArray(trackIds) && trackIds.length > 0) {
            const spotifyTrackUris = trackIds
                .filter(id => typeof id === 'string' && id.trim() !== '')
                .map((id: string) => `spotify:track:${id}`);

            if (spotifyTrackUris.length > 0) {
                 await userSpotifyApi.addTracksToPlaylist(playlistId, spotifyTrackUris);
            } else { console.warn("No valid track IDs provided..."); }
        } else { console.warn("trackIds is not a valid array or is empty."); }

        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlistUrl });

    } catch (err: any) {
        console.error('Failed to create playlist:', err.message || err);
        if (err.body && err.body.error) {
            console.error('Spotify API Error:', err.body.error);
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
